const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { logger } = require('../config/logger');

async function preprocessAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting preprocessing: ${inputPath} to ${outputPath}`);
    ffmpeg(inputPath)
      .audioFilters('volume=1.0,highpass=f=200,lowpass=f=3000')
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('start', (commandLine) => {
        logger.info(`FFmpeg command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        logger.info(`Preprocessing progress for ${inputPath}: ${progress.percent}%`);
      })
      .on('error', (err) => {
        logger.error(`Preprocessing error for ${inputPath}:`, err);
        reject(new Error(`FFmpeg preprocessing failed: ${err.message}`));
      })
      .on('end', () => {
        logger.info(`Preprocessing completed for ${inputPath} to ${outputPath}`);
        resolve();
      })
      .save(outputPath);
  });
}

module.exports = { preprocessAudio };