const ytDlpExec = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');

// set paths to local binaries in backend/bin
const ffmpegPath = path.resolve(__dirname, '../bin/ffmpeg');
const ytDlpPath = path.resolve(__dirname, '../bin/yt-dlp');
ffmpeg.setFfmpegPath(ffmpegPath);

const ytDlp = ytDlpExec.default || ytDlpExec;

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

async function segmentAudio(inputFile, outputTemplate, segmentTime = 60) {
  return new Promise((resolve, reject) => {
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
        logger.debug(`FFmpeg command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        logger.debug(`Segmentation progress for ${inputFile}: ${progress.percent}%`);
      })
      .on('error', (err) => {
        logger.error(`Segmentation error for ${inputFile}:`, err);
        reject(new Error(`FFmpeg segmentation failed: ${err.message}`));
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
  const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`).replace(/\\/g, '/');
  const s3Bucket = process.env.AWS_S3_BUCKET;

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Delete existing local files
    const existingFiles = await fsPromises.readdir(outputDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.includes(videoId) && (file.endsWith('.wav') || file.endsWith('.mp3'))) {
        try {
          await fsPromises.unlink(path.join(outputDir, file));
          logger.debug(`Deleted local file: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete local file ${file}:`, err.message);
        }
      }
    }

    // Delete old S3 objects
    const s3Objects = await s3.listObjectsV2({
      Bucket: s3Bucket,
      Prefix: `audio_${videoId}`
    }).promise();
    if (s3Objects.Contents?.length > 0) {
      await s3.deleteObjects({
        Bucket: s3Bucket,
        Delete: {
          Objects: s3Objects.Contents.map(obj => ({ Key: obj.Key }))
        }
      }).promise();
      logger.debug(`Deleted ${s3Objects.Contents.length} S3 objects for ${videoId}`);
    }

    // Extract audio using yt-dlp
    logger.info(`Extracting audio for ${videoUrl}`);
    await ytDlp(videoUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFile,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      referer: 'https://www.youtube.com/',
      cookies: path.resolve(__dirname, '../cookies/youtube_cookies.txt'),
    }, {
      execPath: ytDlpPath
    });

    logger.debug(`yt-dlp downloaded audio for ${videoId} to ${tempFile}`);

    // Upload mp3 to S3
    const mp3Key = `audio_${videoId}.mp3`;
    await s3.upload({
      Bucket: s3Bucket,
      Key: mp3Key,
      Body: fs.createReadStream(tempFile),
      ContentType: 'audio/mpeg'
    }).promise();
    logger.debug(`Uploaded ${mp3Key} to S3 bucket ${s3Bucket}`);

    // Segment audio to WAV
    const audioChunks = await segmentAudio(tempFile, outputTemplate, 60);
    if (audioChunks.length === 0) {
      logger.error(`No audio chunks created for ${videoId}`);
      throw new Error('No audio chunks created');
    }

    const s3Keys = [];
    for (const chunk of audioChunks) {
      const chunkKey = `audio_${videoId}_${path.basename(chunk)}`;
      await s3.upload({
        Bucket: s3Bucket,
        Key: chunkKey,
        Body: fs.createReadStream(chunk),
        ContentType: 'audio/wav'
      }).promise();
      logger.debug(`Uploaded ${chunkKey} to S3`);
      s3Keys.push(chunkKey);
    }

    logger.info(`Uploaded ${audioChunks.length} chunks to S3`);
    return s3Keys.map(key => `s3://${s3Bucket}/${key}`);
  } catch (error) {
    logger.error(`Audio extraction failed for ${videoId}:`, error);
    throw new Error(`Failed to extract audio: ${error.message}`);
  } finally {
    // Clean up local files
    try {
      await fsPromises.unlink(tempFile);
      logger.debug(`Deleted local temp file: ${tempFile}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Failed to delete local temp file ${tempFile}:`, err.message);
      }
    }

    const localChunks = await fsPromises.readdir(outputDir).catch(() => []);
    for (const file of localChunks) {
      if (file.includes(videoId) && file.endsWith('.wav')) {
        try {
          await fsPromises.unlink(path.join(outputDir, file));
          logger.debug(`Deleted local chunk: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete local chunk ${file}:`, err.message);
        }
      }
    }
  }
}

async function cleanupAudio(s3Uris) {
  const s3Bucket = process.env.AWS_S3_BUCKET;
  const maxRetries = 3;

  for (const uri of s3Uris) {
    const key = uri.replace(`s3://${s3Bucket}/`, '');
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        await s3.deleteObject({ Bucket: s3Bucket, Key: key }).promise();
        logger.debug(`Deleted S3 object: ${key}`);
        break;
      } catch (err) {
        attempts++;
        logger.warn(`Failed to delete S3 object ${key} (attempt ${attempts}):`, err.message);
        if (attempts >= maxRetries) {
          logger.error(`Failed to delete S3 object ${key} after ${maxRetries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

module.exports = { extractAudio, cleanupAudio };