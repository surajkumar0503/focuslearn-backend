const ytDlpExec = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../config/logger');
const { spawn } = require('child_process');

// Set paths to local binaries in backend/bin
const ffmpegPath = path.resolve(__dirname, '../bin/ffmpeg');
const ytDlpPath = path.resolve(__dirname, '../bin/yt-dlp').replace(/\\/g, '/');
ffmpeg.setFfmpegPath(ffmpegPath);
const ytDlp = ytDlpExec.default || ytDlpExec;

// Verify yt-dlp binary exists
if (!fs.existsSync(ytDlpPath)) {
  logger.error(`yt-dlp binary not found at ${ytDlpPath}`);
  throw new Error(`yt-dlp binary not found at ${ytDlpPath}`);
}

// Initialize S3 client
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  region: process.env.AWS_REGION || 'ap-south-1'
});

// Cookie file handling - modified to be optional
const USE_COOKIES = process.env.USE_YOUTUBE_COOKIES === 'true';
let cookiesPath = null;

if (USE_COOKIES) {
  cookiesPath = path.resolve(__dirname, '../cookies/youtube_cookies.txt').replace(/\\/g, '/');
  const cookiesDir = path.dirname(cookiesPath);
  
  async function ensureCookiesDir() {
    try {
      await fsPromises.mkdir(cookiesDir, { recursive: true });
      if (!fs.existsSync(cookiesPath)) {
        // Create a valid Netscape format cookies file
        await fsPromises.writeFile(cookiesPath, 
          "# Netscape HTTP Cookie File\n" +
          "# This is a generated file! Do not edit.\n" +
          "# To use YouTube cookies, add them below this line\n\n"
        );
        logger.debug(`Created valid empty cookies file: ${cookiesPath}`);
      } else {
        // Verify existing cookies file is valid
        const content = await fsPromises.readFile(cookiesPath, 'utf8');
        if (!content.startsWith('# Netscape HTTP Cookie File')) {
          logger.warn('Existing cookies file is not in Netscape format, backing up and creating new one');
          await fsPromises.rename(cookiesPath, `${cookiesPath}.bak`);
          await ensureCookiesDir(); // Recursive call to create new file
        }
      }
    } catch (err) {
      logger.error(`Failed to initialize cookies: ${err.message}`);
      throw new Error(`Failed to initialize cookies: ${err.message}`);
    }
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
        logger.debug(`FFmpeg command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        logger.debug(`Segmentation progress for ${inputFile}: ${progress.percent}%`);
      })
      .on('error', (err) => {
        logger.error(`Segmentation error for ${inputFile}: ${err.message}`);
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
  logger.debug(`Received videoUrl: ${videoUrl}`);
  if (typeof videoUrl !== 'string' || !videoUrl.match(/https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]{11}/)) {
    logger.error(`Invalid video URL: ${JSON.stringify(videoUrl)}`);
    throw new Error(`Invalid video URL: ${JSON.stringify(videoUrl)}`);
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    logger.error('AWS credentials missing');
    throw new Error('AWS credentials missing');
  }

  const outputDir = path.join(__dirname, '..', 'temp');
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) {
    logger.error('Invalid video URL format:', videoUrl);
    throw new Error('Invalid video URL format');
  }
  const tempFile = path.join(outputDir, `audio_${videoId}.mp3`).replace(/\\/g, '/');
  const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`).replace(/\\/g, '/');
  const s3Bucket = process.env.AWS_S3_BUCKET || 'focuslearn-audio-2025';

  try {
    // Create temp directory
    await fsPromises.mkdir(outputDir, { recursive: true });
    
    // Initialize cookies if needed
    if (USE_COOKIES) {
      await ensureCookiesDir();
    }

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

    // Prepare yt-dlp options
    const ytDlpOptions = {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFile,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      referer: 'https://www.youtube.com/'
    };

    // Add cookies only if enabled and file exists
    if (USE_COOKIES && fs.existsSync(cookiesPath)) {
      ytDlpOptions.cookies = cookiesPath;
    }

    // Extract audio with retry logic
    const maxRetries = 3;
    let attempt = 0;
    let audioExtracted = false;
    let errorMessage = '';

    while (attempt < maxRetries && !audioExtracted) {
      attempt++;
      logger.info(`Attempt ${attempt} to extract audio for ${videoUrl} using yt-dlp binary: ${ytDlpPath}`);
      try {
        const startExtract = Date.now();
        await ytDlp(videoUrl, ytDlpOptions, {
          execPath: ytDlpPath
        });
        logger.debug(`yt-dlp downloaded audio for ${videoId} to ${tempFile} in ${Date.now() - startExtract}ms`);
        audioExtracted = true;
      } catch (error) {
        errorMessage = error.message;
        if (error.stderr?.includes('HTTP Error 429')) {
          logger.warn(`Rate limit hit on attempt ${attempt} for ${videoId}: ${error.stderr}`);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
            logger.info(`Retrying after ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } else if (error.stderr?.includes('This content is not available')) {
          logger.error(`Video ${videoId} is unavailable: ${error.stderr}`);
          throw new Error(`Video unavailable: ${error.message}`);
        } else if (error.message.includes('cookies')) {
          logger.warn(`Cookie-related error, retrying without cookies`);
          delete ytDlpOptions.cookies; // Remove cookies option if it's causing issues
        } else {
          logger.error(`yt-dlp failed for ${videoId}: ${error.message}`);
          throw error;
        }
      }
    }

    if (!audioExtracted) {
      logger.error(`Failed to extract audio for ${videoId} after ${maxRetries} attempts: ${errorMessage}`);
      throw new Error(`Failed to extract audio after ${maxRetries} attempts: ${errorMessage}`);
    }

    await fsPromises.access(tempFile);

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
    if (audioChunks.length === 1) {
      logger.warn(`Only one audio chunk created for ${videoId}. Video may be short or segmentation failed.`);
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
        await s3.deleteObject({ Bucket: s3Bucket, Key: key }).promise();
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