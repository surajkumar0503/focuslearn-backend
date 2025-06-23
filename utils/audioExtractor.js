const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function checkDependencies() {
  try {
    await execPromise('/opt/bin/yt-dlp --version');
    await execPromise('/opt/bin/ffmpeg -version');
    logger.info('Dependencies checked: yt-dlp and ffmpeg are available');
  } catch (error) {
    logger.error('Dependency check failed:', error);
    throw new Error('Required dependencies (yt-dlp or ffmpeg) are missing');
  }
}

async function uploadToS3(filePath, key, bucket) {
  try {
    const fileContent = await fs.readFile(filePath);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileContent,
      ContentType: 'audio/wav'
    });
    await s3Client.send(command);
    logger.info(`Uploaded ${filePath} to S3: ${key}`);
    return key;
  } catch (error) {
    logger.error(`Failed to upload ${filePath} to S3:`, error);
    throw new Error(`S3 upload failed: ${error.message}`);
  }
}

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
        logger.info(`FFmpeg segmentation command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        logger.info(`Segmentation progress for ${inputFile}: ${progress.percent}%`);
      })
      .on('error', (err) => {
        logger.error(`Segmentation error for ${inputFile}:`, err);
        reject(new Error(`FFmpeg segmentation failed: ${err.message}`));
      })
      .on('end', async () => {
        logger.info(`Segmentation completed for ${inputFile}`);
        const dir = path.dirname(outputTemplate);
        const files = await fs.readdir(dir);
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
  await checkDependencies();
  const bucket = process.env.S3_BUCKET_NAME;
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) {
    logger.error('Invalid video URL:', videoUrl);
    throw new Error('Invalid video URL');
  }
  const tempDir = '/tmp';
  const tempFile = path.join(tempDir, `audio_${videoId}.mp3`).replace(/\\/g, '/');
  const outputTemplate = path.join(tempDir, `audio_${videoId}_%03d.wav`).replace(/\\/g, '/');

  try {
    await fs.mkdir(tempDir, { recursive: true });

    const existingFiles = await fs.readdir(tempDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.includes(videoId) && (file.endsWith('.wav') || file.endsWith('.mp3'))) {
        try {
          await fs.unlink(path.join(tempDir, file));
          logger.info(`Deleted old file: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete old file ${file}:`, err.message);
        }
      }
    }

    const command = `/opt/bin/yt-dlp -x --audio-format mp3 -o "${tempFile}" "${videoUrl}"`;
    const { stdout, stderr } = await execPromise(command);
    logger.info(`yt-dlp output for ${videoId}: ${stdout}`);
    if (stderr) logger.warn(`yt-dlp warnings for ${videoId}: ${stderr}`);

    await fs.access(tempFile);

    const audioChunks = await segmentAudio(tempFile, outputTemplate, 60);
    if (audioChunks.length === 0) {
      logger.error(`No audio chunks created for ${videoId}`);
      throw new Error('No audio chunks created');
    }
    if (audioChunks.length === 1) {
      logger.warn(`Only one audio chunk created for ${videoId}. Video may be short or segmentation failed.`);
    }

    const s3Keys = [];
    for (const chunk of audioChunks) {
      const s3Key = `audio_chunks/${videoId}/${path.basename(chunk)}`;
      await uploadToS3(chunk, s3Key, bucket);
      s3Keys.push(s3Key);
    }

    logger.info(`Extracted and uploaded ${s3Keys.length} audio chunks for ${videoId} to S3`);
    return s3Keys;
  } catch (error) {
    logger.error(`Audio extraction failed for ${videoId}:`, error);
    throw new Error(`Failed to extract audio: ${error.message}`);
  } finally {
    try {
      await fs.unlink(tempFile);
      logger.info(`Deleted temp file: ${tempFile}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Failed to delete temp file ${tempFile}:`, err.message);
      }
    }
  }
}

async function cleanupAudio(s3Keys) {
  const bucket = process.env.S3_BUCKET_NAME;
  const maxRetries = 3;
  for (const key of s3Keys) {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: bucket,
          Key: key
        });
        await s3Client.send(command);
        logger.info(`Deleted S3 file: ${key}`);
        break;
      } catch (err) {
        attempts++;
        logger.warn(`Failed to delete ${key} (attempt ${attempts}):`, err.message);
        if (attempts >= maxRetries) {
          logger.error(`Failed to delete ${key} after ${maxRetries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

module.exports = { extractAudio, cleanupAudio };