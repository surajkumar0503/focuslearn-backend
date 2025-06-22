const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');

// Set ffmpeg path
ffmpeg.setFfmpegPath(path.join(__dirname, '..', 'bin', 'ffmpeg'));

const s3Client = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  region: process.env.AWS_REGION
});

async function segmentAudio(inputFile, outputDir, videoId, segmentTime = 30) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`).replace(/\\/g, '/');
    const chunks = [];
    ffmpeg(inputFile)
      .outputOptions([
        '-f segment',
        `-segment_time ${segmentTime}`,
        '-c:a pcm_s16le',
        '-segment_format wav',
      ])
      .output(outputTemplate)
      .on('start', (commandLine) => {
        logger.debug(`FFmpeg segmentation command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        logger.debug(`Segmentation progress for ${inputFile}: ${progress.percent}%`);
      })
      .on('error', (err) => {
        logger.error(`Segmentation error for ${inputFile}: ${err.message}`);
        reject(new Error(`Segmentation failed: ${err.message}`));
      })
      .on('end', async () => {
        logger.info(`Segmentation completed for ${inputFile}`);
        const dir = path.dirname(outputTemplate);
        const files = await fsPromises.readdir(dir);
        for (const file of files) {
          if (file.match(/audio_.*_\d{3}\.wav$/) && !file.includes('_preprocessed')) {
            chunks.push(path.join(dir, file));
          }
        }
        logger.info(`Segmented ${chunks.length} chunks: ${chunks.join(', ')}`);
        resolve(chunks.sort());
      })
      .run();
  });
}

async function extractAudio(videoUrl) {
  const outputDir = path.join(__dirname, '..', 'temp');
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) {
    logger.error('Invalid video URL:', videoUrl);
    throw new Error('Invalid video URL');
  }
  const tempFile = path.join(outputDir, `audio_${videoId}.mp3`).replace(/\\/g, '/');
  const s3Bucket = process.env.AWS_S3_BUCKET || 'focuslearn-audio-2025';

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Clean up existing local files
    const existingFiles = await fsPromises.readdir(outputDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.includes(videoId) && (file.endsWith('.wav') || file.endsWith('.mp3'))) {
        try {
          await fsPromises.unlink(path.join(outputDir, file));
          logger.debug(`Deleted local file: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete local file ${file}: ${err.message}`);
        }
      }
    }

    // Clean up existing S3 objects
    const listCommand = new ListObjectsV2Command({
      Bucket: s3Bucket,
      Prefix: `audio_${videoId}`
    });
    const s3Objects = await s3Client.send(listCommand);
    if (s3Objects.Contents?.length > 0) {
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: s3Bucket,
        Delete: {
          Objects: s3Objects.Contents.map(obj => ({ Key: obj.Key }))
        }
      });
      await s3Client.send(deleteCommand);
      logger.debug(`Deleted ${s3Objects.Contents.length} S3 objects for ${videoId}`);
    }

    logger.info(`Extracting audio for ${videoUrl}`);
    const startExtract = Date.now();
    await ytDlp(videoUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFile
    });
    logger.debug(`yt-dlp-exec downloaded audio for ${videoId} to ${tempFile} in ${Date.now() - startExtract}ms`);

    await fsPromises.access(tempFile);

    const mp3Key = `audio_${videoId}.mp3`;
    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: mp3Key,
      Body: fs.createReadStream(tempFile),
      ContentType: 'audio/mpeg'
    }));
    logger.debug(`Uploaded ${mp3Key} to S3 bucket ${s3Bucket}`);

    const audioChunks = await segmentAudio(tempFile, outputDir, videoId, 30);
    if (audioChunks.length === 0) {
      logger.error(`No audio chunks created for ${videoId}`);
      throw new Error('No audio chunks created');
    }
    if (audioChunks.length === 1) {
      logger.warn(`Only one audio chunk created for ${videoId}. Video may be short or segmentation failed.`);
    }

    const s3Keys = [];
    for (const chunk of audioChunks) {
      const chunkKey = `audio_${videoId}_${path.basename(chunk)}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: chunkKey,
        Body: fs.createReadStream(chunk),
        ContentType: 'audio/wav'
      }));
      logger.debug(`Uploaded ${chunkKey} to S3 bucket ${s3Bucket}`);
      s3Keys.push(chunkKey);
    }

    logger.info(`Extracted ${audioChunks.length} audio chunks for ${videoId}: ${audioChunks.join(', ')}`);
    return s3Keys.map(key => `s3://${s3Bucket}/${key}`);
  } catch (error) {
    logger.error(`Audio extraction failed for ${videoId}: ${error.message}`);
    throw new Error(`Failed to extract audio: ${error.message}`);
  } finally {
    try {
      await fsPromises.unlink(tempFile);
      logger.debug(`Deleted local temp file: ${tempFile}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Failed to delete local temp file ${tempFile}: ${err.message}`);
      }
    }
    const localChunks = await fsPromises.readdir(outputDir).catch(() => []);
    for (const file of localChunks) {
      if (file.includes(videoId) && file.endsWith('.wav')) {
        try {
          await fsPromises.unlink(path.join(outputDir, file));
          logger.debug(`Deleted local chunk: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete local chunk ${file}: ${err.message}`);
        }
      }
    }
  }
}

async function cleanupAudio(s3Uris) {
  const s3Bucket = process.env.AWS_S3_BUCKET || 'focuslearn-audio-2025';
  const maxRetries = 3;

  for (const uri of s3Uris) {
    const key = uri.replace(`s3://${s3Bucket}/`, '');
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        await s3Client.send(new DeleteObjectsCommand({
          Bucket: s3Bucket,
          Delete: { Objects: [{ Key: key }] }
        }));
        logger.debug(`Deleted S3 object: ${key}`);
        break;
      } catch (err) {
        attempts++;
        logger.warn(`Failed to delete S3 object ${key} (attempt ${attempts}): ${err.message}`);
        if (attempts >= maxRetries) {
          logger.error(`Failed to delete S3 object ${key} after ${maxRetries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

module.exports = { extractAudio, cleanupAudio };