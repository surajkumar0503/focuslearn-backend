const { YoutubeTranscript } = require('youtube-transcript');
const { extractAudio, cleanupAudio } = require('../utils/audioExtractor');
const { preprocessAudio } = require('../utils/audioPreprocessor');
const Groq = require('groq-sdk');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const Transcript = require('../models/Transcript');
const { fetchVideoDetails } = require('./videoService');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { logger } = require('../config/logger');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function fetchTranscript(videoId, language = 'en') {
  logger.info(`Fetching transcript for video ${videoId}`);
  try {
    const cached = await Transcript.findOne({ videoId });
    if (cached) {
      logger.info(`Using cached transcript for ${videoId}`);
      return cached.transcript;
    }

    let transcript;
    try {
      transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: language });
    } catch (error) {
      logger.warn(`No transcript in ${language} for ${videoId}, trying fallback languages...`);
      const fallbackLangs = ['ta', 'hi', 'en'];
      for (const lang of fallbackLangs) {
        try {
          transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
          break;
        } catch (err) {
          logger.warn(`No transcript in ${lang}`);
        }
      }
    }

    if (transcript && transcript.length > 0) {
      const formatted = transcript.map(item => ({
        text: item.text,
        offset: item.offset,
        duration: item.duration
      }));
      try {
        await Transcript.create({ videoId, transcript: formatted });
        logger.info(`Saved public transcript for ${videoId}`);
      } catch (error) {
        if (error.code === 11000) {
          logger.warn(`Duplicate transcript for ${videoId}, using cached`);
          return (await Transcript.findOne({ videoId })).transcript;
        }
        throw error;
      }
      return formatted;
    }
    throw new Error('No public transcript available');
  } catch (error) {
    logger.warn(`Public transcript unavailable for ${videoId}: ${error.message}`);
    try {
      const transcript = await generateWhisperTranscript(videoId, language);
      try {
        await Transcript.create({ videoId, transcript });
        logger.info(`Saved Whisper transcript for ${videoId}`);
      } catch (createError) {
        if (createError.code === 11000) {
          logger.warn(`Duplicate transcript for ${videoId}, using cached`);
          return (await Transcript.findOne({ videoId })).transcript;
        }
        throw createError;
      }
      return transcript;
    } catch (whisperError) {
      logger.error(`Failed to generate transcript for ${videoId}:`, whisperError);
      throw new Error('Failed to fetch or generate transcript');
    }
  }
}

async function generateWhisperTranscript(videoId, language) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let s3Keys = [];
  let preprocessedKeys = [];

  try {
    logger.info(`Fetching video details for ${videoId}`);
    const videoDetails = await fetchVideoDetails(videoId);
    const prompt = videoDetails?.title || '';
    logger.info(`Video title: ${prompt}`);

    logger.info(`Extracting audio for ${videoUrl}`);
    s3Keys = await extractAudio(videoUrl);
    logger.info(`Extracted ${s3Keys.length} audio chunks`);

    const preprocessPromises = s3Keys.map(async (s3Key) => {
      const localChunk = path.join('/tmp', path.basename(s3Key));
      const preprocessedFile = localChunk.replace('.wav', '_preprocessed.wav');
      const preprocessedKey = s3Key.replace('.wav', '_preprocessed.wav');

      try {
        const command = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: s3Key
        });
        const { Body } = await s3Client.send(command);
        await new Promise((resolve, reject) => {
          const fileStream = fs.createWriteStream(localChunk);
          Body.pipe(fileStream);
          fileStream.on('error', reject);
          fileStream.on('close', resolve);
        });
        logger.info(`Downloaded ${s3Key} to ${localChunk}`);

        await preprocessAudio(localChunk, preprocessedFile);
        await fsPromises.access(preprocessedFile);

        const preprocessedS3Key = await uploadToS3(preprocessedFile, preprocessedKey, process.env.S3_BUCKET_NAME);
        return preprocessedS3Key;
      } catch (error) {
        logger.error(`Preprocessing failed for ${s3Key}:`, error);
        throw new Error(`Audio preprocessing failed: ${error.message}`);
      } finally {
        try {
          await fs.unlink(localChunk);
          await fs.unlink(preprocessedFile);
        } catch (err) {
          logger.warn(`Failed to delete local file: ${err.message}`);
        }
      }
    });

    preprocessedKeys = await Promise.all(preprocessPromises);
    logger.info(`Preprocessed ${preprocessedKeys.length} chunks`);

    let fullTranscript = [];
    let offset = 0;
    for (const s3Key of preprocessedKeys) {
      const localChunk = path.join('/tmp', path.basename(s3Key));
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: s3Key
        });
        const { Body } = await s3Client.send(command);
        await new Promise((resolve, reject) => {
          const fileStream = fs.createWriteStream(localChunk);
          Body.pipe(fileStream);
          fileStream.on('error', reject);
          fileStream.on('close', resolve);
        });
        logger.info(`Downloaded ${s3Key} to ${localChunk}`);

        let attempts = 0;
        const maxRetries = 3;
        while (attempts < maxRetries) {
          try {
            await fsPromises.access(localChunk);
            const startTime = Date.now();
            const stream = fs.createReadStream(localChunk);
            stream.on('error', (err) => {
              logger.error(`Stream error for ${localChunk}:`, err);
              throw new Error(`Failed to read audio file: ${err.message}`);
            });
            const transcription = await Promise.race([
              groq.audio.transcriptions.create({
                file: stream,
                model: 'whisper-large-v3',
                response_format: 'verbose_json',
                language,
                prompt,
                temperature: 0
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timeout')), 60000))
            ]);
            logger.info(`Transcription for ${localChunk} took ${Date.now() - startTime}ms: ${transcription.segments.length} segments`);
            const segments = transcription.segments.filter(
              segment => segment.avg_logprob > -0.4 && segment.no_speech_prob < 0.4
            );
            fullTranscript.push(
              ...segments.map(segment => ({
                text: segment.text,
                offset: (segment.start + offset) * 1000,
                duration: (segment.end - segment.start) * 1000
              }))
            );
            offset += segments[segments.length - 1]?.end || 60;
            break;
          } catch (error) {
            attempts++;
            logger.error(`Transcription attempt ${attempts} failed for ${s3Key}: ${error.message}`);
            if (error.status === 429 || error.message.includes('rate_limit') || error.message === 'Transcription timeout') {
              const retryAfter = parseInt(error.headers?.['retry-after']) * 1000 || Math.pow(2, attempts) * 1000;
              logger.warn(`Retryable error, retrying after ${retryAfter}ms`);
              if (attempts >= maxRetries) {
                throw new Error(`Transcription failed after ${maxRetries} retries: ${error.message}`);
              }
              await new Promise(resolve => setTimeout(resolve, retryAfter));
            } else {
              throw new Error(`Whisper transcription failed: ${error.message}`);
            }
          }
        }
      } finally {
        try {
          await fs.unlink(localChunk);
          logger.info(`Deleted local file: ${localChunk}`);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn(`Failed to delete local file ${localChunk}:`, err.message);
          }
        }
      }
    }

    if (fullTranscript.length > 0) {
      const rawText = fullTranscript.map(item => item.text).join(' ');
      logger.info(`Raw transcript length: ${rawText.length} chars`);
      const refinedText = await refineTranscript(rawText, prompt);
      let refinedIndex = 0;
      const finalTranscript = fullTranscript.map(item => {
        const length = item.text.length;
        const refinedSegment = refinedText.slice(refinedIndex, refinedIndex + length);
        refinedIndex += length;
        return { ...item, text: refinedSegment };
      });
      logger.info(`Final transcript generated with ${finalTranscript.length} segments`);
      return finalTranscript;
    }

    throw new Error('No valid transcript generated');
  } catch (error) {
    logger.error(`Whisper transcription failed for ${videoId}:`, error);
    throw new Error(`Failed to generate transcript: ${error.message}`);
  } finally {
    if (s3Keys.length > 0 || preprocessedKeys.length > 0) {
      logger.info(`Cleaning up ${s3Keys.length + preprocessedKeys.length} S3 files`);
      await cleanupAudio([...s3Keys, ...preprocessedKeys]);
    }
  }
}

async function refineTranscript(rawText, videoTitle) {
  try {
    logger.info(`Refining transcript for ${videoTitle}`);
    const response = await Promise.race([
      groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are an expert editor. Correct grammar, spelling, and context errors in the transcript, using the video title as context: "' + videoTitle + '"'
          },
          { role: 'user', content: rawText }
        ],
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        temperature: 0
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Refinement timeout')), 60000))
    ]);
    logger.info(`Refined transcript received`);
    return response.choices[0]?.message?.content || rawText;
  } catch (error) {
    logger.error('Transcript refinement failed:', error);
    return rawText;
  }
}

async function uploadToS3(filePath, key, bucket) {
  try {
    const fileContent = await fsPromises.readFile(filePath);
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

module.exports = { fetchTranscript };