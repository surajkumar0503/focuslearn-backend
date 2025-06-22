const ytDlpExec = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');
const { spawn } = require('child_process');

// Configuration
const MAX_RETRIES = 5;
const RETRY_DELAY_BASE = 2000;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0'
];

// Binary paths
const ffmpegPath = path.resolve(__dirname, '../bin/ffmpeg');
const ytDlpPath = path.resolve(__dirname, '../bin/yt-dlp').replace(/\\/g, '/');
ffmpeg.setFfmpegPath(ffmpegPath);
const ytDlp = ytDlpExec.default || ytDlpExec;

// Verify binaries
if (!fs.existsSync(ytDlpPath)) {
  throw new Error(`yt-dlp binary not found at ${ytDlpPath}`);
}

// S3 Configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'ap-south-1'
});

// Cookie handling
const USE_COOKIES = process.env.USE_YOUTUBE_COOKIES === 'true';
let cookiesPath = null;

if (USE_COOKIES) {
  cookiesPath = path.resolve(__dirname, '../cookies/youtube_cookies.txt');

  async function ensureCookiesFile() {
    try {
      await fsPromises.mkdir(path.dirname(cookiesPath), { recursive: true });
      if (!fs.existsSync(cookiesPath)) {
        await fsPromises.writeFile(cookiesPath,
          "# Netscape HTTP Cookie File\n" +
          "# This is a generated file! Do not edit.\n\n"
        );
      }
    } catch (err) {
      logger.error(`Cookie file error: ${err.message}`);
      throw err;
    }
  }
}

// Audio processing functions
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
      .on('start', (cmd) => logger.debug(`FFmpeg command: ${cmd}`))
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .on('end', async () => {
        const dir = path.dirname(outputTemplate);
        const files = await fsPromises.readdir(dir);
        chunks.push(...files
          .filter(file => file.match(/audio_.*_\d{3}\.wav$/) && !file.includes('_preprocessed'))
          .map(file => path.join(dir, file))
          .sort());
        resolve(chunks);
      })
      .run();
  });
}

async function extractAudio(videoUrl) {
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) throw new Error('Invalid YouTube URL');

  const outputDir = path.join(__dirname, '..', 'temp');
  const tempFile = path.join(outputDir, `audio_${videoId}.mp3`);
  const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`);
  const s3Bucket = process.env.AWS_S3_BUCKET;

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });
    await cleanupFiles(outputDir, videoId);

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ytDlpOptions = {
          extractAudio: true,
          audioFormat: 'mp3',
          output: tempFile,
          userAgent: USER_AGENTS[attempt % USER_AGENTS.length],
          referer: 'https://www.youtube.com/',
          noCheckCertificates: true,
          socketTimeout: 30000,
          forceIpv4: true,
          ...(USE_COOKIES && { cookies: cookiesPath }),
          ...(process.env.YT_PROXY && { proxy: process.env.YT_PROXY })
        };

        logger.info(`Download attempt ${attempt} for ${videoId}`);
        await ytDlp(videoUrl, ytDlpOptions, { execPath: ytDlpPath });

        // Verify download
        const stats = await fsPromises.stat(tempFile);
        if (stats.size < 1024) throw new Error('File too small, likely failed');

        // Process and upload
        const audioChunks = await segmentAudio(tempFile, outputTemplate);
        const s3Keys = await uploadToS3(audioChunks, videoId, s3Bucket);

        return s3Keys.map(key => `s3://${s3Bucket}/${key}`);
      } catch (error) {
        lastError = error;
        await handleRetry(error, attempt);
      }
    }
    throw new Error(`All attempts failed. Last error: ${lastError?.message}`);
  } finally {
    await cleanupFiles(outputDir, videoId);
  }
}

// Helper functions
async function cleanupFiles(dir, videoId) {
  try {
    const files = await fsPromises.readdir(dir);
    await Promise.all(files.map(file =>
      file.includes(videoId) && fsPromises.unlink(path.join(dir, file))
    ));
  } catch (err) {
    logger.warn(`Cleanup error: ${err.message}`);
  }
}

async function uploadToS3(chunks, videoId, bucket) {
  const s3Keys = [];
  for (const chunk of chunks) {
    const key = `audio_${videoId}_${path.basename(chunk)}`;
    await s3.upload({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(chunk),
      ContentType: 'audio/wav'
    }).promise();
    s3Keys.push(key);
  }
  return s3Keys;
}

async function handleRetry(error, attempt) {
  if (error.message.includes('rate limit') || error.message.includes('429')) {
    const delay = Math.min(RETRY_DELAY_BASE * Math.pow(2, attempt), 60000);
    logger.warn(`Rate limited, waiting ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return;
  }

  if (error.message.includes('unavailable')) {
    throw new Error('Video is unavailable or private');
  }

  logger.error(`Attempt ${attempt} failed: ${error.message}`);
  if (attempt < MAX_RETRIES) {
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE));
  }
}

async function cleanupAudio(s3Uris) {
  const bucket = process.env.AWS_S3_BUCKET;
  await Promise.all(s3Uris.map(uri => {
    const key = uri.replace(`s3://${bucket}/`, '');
    return s3.deleteObject({ Bucket: bucket, Key: key }).promise();
  }));
}

module.exports = { extractAudio, cleanupAudio };