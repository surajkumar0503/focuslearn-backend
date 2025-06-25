const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const {logger} = require('../config/logger');

async function checkDependencies() {
  try {
    await execPromise('yt-dlp --version');
    await execPromise('ffmpeg -version');
    logger.info('Dependencies checked: yt-dlp and ffmpeg are available');
  } catch (error) {
    logger.error('Dependency check failed:', error);
    throw new Error('Required dependencies (yt-dlp or ffmpeg) are missing');
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
  const outputDir = path.join(__dirname, '..', 'temp');
  const videoId = videoUrl.match(/v=([^&]+)/)?.[1];
  if (!videoId) {
    logger.error('Invalid video URL:', videoUrl);
    throw new Error('Invalid video URL');
  }
  const tempFile = path.join(outputDir, `audio_${videoId}.mp3`).replace(/\\/g, '/');
  const outputTemplate = path.join(outputDir, `audio_${videoId}_%03d.wav`).replace(/\\/g, '/');

  try {
    await fs.mkdir(outputDir, { recursive: true });

    // clean up existing files for this videoId
    const existingFiles = await fs.readdir(outputDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.includes(videoId) && (file.endsWith('.wav') || file.endsWith('.mp3'))) {
        try {
          await fs.unlink(path.join(outputDir, file));
          logger.info(`Deleted old file: ${file}`);
        } catch (err) {
          logger.warn(`Failed to delete old file ${file}:`, err.message);
        }
      }
    }

    logger.info(`Extracting audio for ${videoUrl}`);
    // download audio as mp3
    const command = `yt-dlp -x --audio-format mp3 -o "${tempFile}" "${videoUrl}"`;
    const { stdout, stderr } = await execPromise(command);
    logger.info(`yt-dlp output for ${videoId}: ${stdout}`);
    if (stderr) logger.warn(`yt-dlp warnings for ${videoId}: ${stderr}`);

    // verify temp file exists
    await fs.access(tempFile);

    // segment audio using fluent-ffmpeg
    const audioChunks = await segmentAudio(tempFile, outputTemplate, 60);
    if (audioChunks.length === 0) {
      logger.error(`No audio chunks created for ${videoId}`);
      throw new Error('No audio chunks created');
    }
    if (audioChunks.length === 1) {
      logger.warn(`Only one audio chunk created for ${videoId}. Video may be short or segmentation failed.`);
    }
    logger.info(`Extracted ${audioChunks.length} audio chunks for ${videoId}: ${audioChunks.join(', ')}`);
    return audioChunks;
  } catch (error) {
    logger.error(`Audio extraction failed for ${videoId}:`, error);
    throw new Error(`Failed to extract audio: ${error.message}`);
  } finally {
    // clean up temp chunk file
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

async function cleanupAudio(audioFiles) {
  const maxRetries = 3;
  for (const file of audioFiles) {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        await fs.access(file);
        await fs.unlink(file);
        logger.info(`Deleted audio file: ${file}`);
        break;
      } catch (err) {
        attempts++;
        if (err.code === 'ENOENT') {
          logger.warn(`File ${file} already deleted or does not exist`);
          break;
        }
        logger.warn(`Failed to delete ${file} (attempt ${attempts}):`, err.message);
        if (attempts >= maxRetries) {
          logger.error(`Failed to delete ${file} after ${maxRetries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

module.exports = { extractAudio, cleanupAudio };