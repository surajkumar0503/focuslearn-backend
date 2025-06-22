const ytDlpExec = require('yt-dlp-exec');
const ytdl = require('ytdl-core');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');

// Enhanced Configuration
const CONFIG = {
  MAX_RETRIES: process.env.MAX_DOWNLOAD_ATTEMPTS || 3,
  RETRY_DELAY_BASE: 5000,
  DOWNLOAD_TIMEOUT: 60000,
  MIN_FILE_SIZE: 1024, // 1KB minimum file size
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'
  ]
};

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

class DownloadError extends Error {
  constructor(message, originalError, context = {}) {
    super(message);
    this.name = 'DownloadError';
    this.originalError = originalError;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
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
      .on('error', (err) => reject(new DownloadError('Audio segmentation failed', err)))
      .on('end', async () => {
        try {
          const dir = path.dirname(outputTemplate);
          const files = await fsPromises.readdir(dir);
          chunks.push(...files
            .filter(file => file.match(/audio_.*_\d{3}\.wav$/) && !file.includes('_preprocessed'))
            .map(file => path.join(dir, file))
            .sort());
          resolve(chunks);
        } catch (err) {
          reject(new DownloadError('Failed to process audio chunks', err));
        }
      })
      .run();
  });
}

const downloadMethods = {
  yt_dlp: async (videoUrl, outputPath, attempt) => {
    const options = {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputPath,
      userAgent: CONFIG.USER_AGENTS[attempt % CONFIG.USER_AGENTS.length],
      referer: 'https://www.youtube.com/',
      noCheckCertificates: true,
      socketTimeout: 30000,
      forceIpv4: true,
      ...(USE_COOKIES && { cookies: cookiesPath }),
      ...(process.env.YT_PROXY && { proxy: process.env.YT_PROXY })
    };

    return ytDlp(videoUrl, options, {
      execPath: ytDlpPath,
      timeout: CONFIG.DOWNLOAD_TIMEOUT,
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer
    });
  },

  ytdl_core: async (videoUrl, outputPath) => {
    return new Promise((resolve, reject) => {
      const stream = ytdl(videoUrl, { 
        quality: 'highestaudio',
        filter: 'audioonly',
        highWaterMark: 1 << 25, // 32MB buffer
        requestOptions: {
          timeout: CONFIG.DOWNLOAD_TIMEOUT,
          ...(process.env.YT_PROXY && { proxy: process.env.YT_PROXY })
        }
      })
      .on('error', reject)
      .pipe(fs.createWriteStream(outputPath))
      .on('finish', resolve)
      .on('error', reject);
    });
  }
};

async function extractAudio(videoUrl) {
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) throw new DownloadError('Invalid YouTube URL');

  const outputDir = path.join(__dirname, '..', 'temp');
  const tempFile = path.join(outputDir, `audio_${videoId}.mp3`);
  const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`);
  const s3Bucket = process.env.AWS_S3_BUCKET;

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });
    await cleanupFiles(outputDir, videoId);

    // Try yt-dlp first
    let lastError;
    try {
      await attemptDownloadWithRetry(videoUrl, tempFile);
    } catch (ytDlpError) {
      lastError = ytDlpError;
      logger.warn(`yt-dlp failed: ${lastError.message}`);
      
      // Fallback to ytdl-core if enabled
      if (process.env.YTDL_CORE_FALLBACK === 'true') {
        try {
          logger.info('Attempting ytdl-core fallback');
          await downloadMethods.ytdl_core(videoUrl, tempFile);
        } catch (ytdlError) {
          throw new DownloadError(
            'All download methods failed',
            ytdlError,
            {
              videoId,
              attempts: CONFIG.MAX_RETRIES,
              lastMethod: 'ytdl-core',
              previousErrors: lastError.message
            }
          );
        }
      } else {
        throw lastError;
      }
    }

    // Verify download
    await verifyDownload(tempFile);

    // Process and upload
    const audioChunks = await segmentAudio(tempFile, outputTemplate);
    const s3Keys = await uploadToS3(audioChunks, videoId, s3Bucket);

    return s3Keys.map(key => `s3://${s3Bucket}/${key}`);
  } finally {
    await cleanupFiles(outputDir, videoId);
  }
}

async function attemptDownloadWithRetry(videoUrl, outputPath) {
  let lastError;
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      logger.info(`Download attempt ${attempt}/${CONFIG.MAX_RETRIES}`);
      await downloadMethods.yt_dlp(videoUrl, outputPath, attempt);
      return;
    } catch (error) {
      lastError = error;
      
      if (shouldRetry(error)) {
        const delay = getRetryDelay(attempt);
        logger.warn(`Retryable error, waiting ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw new DownloadError(
        'YouTube download failed',
        error,
        { attempt, videoId: videoUrl.match(/v=([^&]+)/)?.[1] }
      );
    }
  }
  
  throw lastError;
}

function shouldRetry(error) {
  return error.message.includes('rate limit') || 
         error.message.includes('429') ||
         error.message.includes('timeout');
}

function getRetryDelay(attempt) {
  return Math.min(CONFIG.RETRY_DELAY_BASE * Math.pow(2, attempt - 1), 60000);
}

async function verifyDownload(filePath) {
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.size < CONFIG.MIN_FILE_SIZE) {
      throw new Error(`File too small (${stats.size} bytes)`);
    }
  } catch (err) {
    throw new DownloadError('Download verification failed', err);
  }
}

async function cleanupFiles(dir, videoId) {
  try {
    const files = await fsPromises.readdir(dir).catch(() => []);
    await Promise.all(files.map(file => {
      if (file.includes(videoId)) {
        return fsPromises.unlink(path.join(dir, file)).catch(() => {});
      }
    }));
  } catch (err) {
    logger.warn(`Cleanup error: ${err.message}`);
  }
}

async function uploadToS3(chunks, videoId, bucket) {
  const s3Keys = [];
  
  for (const chunk of chunks) {
    try {
      const key = `audio_${videoId}_${path.basename(chunk)}`;
      await s3.upload({
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(chunk),
        ContentType: 'audio/wav'
      }).promise();
      s3Keys.push(key);
    } catch (err) {
      logger.error(`Failed to upload ${chunk}: ${err.message}`);
      throw new DownloadError('S3 upload failed', err, { chunk });
    }
  }
  
  return s3Keys;
}

async function cleanupAudio(s3Uris) {
  const bucket = process.env.AWS_S3_BUCKET;
  
  await Promise.all(s3Uris.map(uri => {
    const key = uri.replace(`s3://${bucket}/`, '');
    return s3.deleteObject({ Bucket: bucket, Key: key })
      .promise()
      .catch(err => logger.warn(`Failed to delete ${key}: ${err.message}`));
  }));
}

module.exports = { extractAudio, cleanupAudio, DownloadError };