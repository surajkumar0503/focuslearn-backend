const { YoutubeTranscript } = require('youtube-transcript');
const { extractAudio, cleanupAudio } = require('../utils/audioExtractor');
const { preprocessAudio } = require('../utils/audioPreprocessor');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const Transcript = require('../models/Transcript');
const { fetchVideoDetails } = require('./videoService');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const AWS = require('aws-sdk');
const { logger } = require('../config/logger');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
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
  let s3Uris = [];
  const outputDir = path.join(__dirname, '..', 'temp');

  try {
    logger.info(`Fetching video details for ${videoId}`);
    const videoDetails = await fetchVideoDetails(videoId);
    const prompt = videoDetails?.title || '';
    logger.info(`Video title: ${prompt}`);

    logger.info(`Extracting audio for ${videoUrl}`);
    s3Uris = await extractAudio(videoUrl);
    logger.info(`Extracted ${s3Uris.length} audio chunks`);

    await fsPromises.mkdir(outputDir, { recursive: true });

    const localFiles = [];
    for (const uri of s3Uris) {
      const key = uri.replace(`s3://${process.env.AWS_S3_BUCKET}/`, '');
      const localFile = path.join(outputDir, path.basename(key));
      logger.debug(`Downloading ${key} from S3 to ${localFile}`);
      const s3Data = await s3.getObject({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key
      }).promise();
      await fsPromises.writeFile(localFile, s3Data.Body);
      localFiles.push(localFile);
    }

    const preprocessedFiles = [];
    for (const localFile of localFiles) {
      const preprocessedFile = localFile.replace('.wav', '_preprocessed.wav');
      logger.debug(`Preprocessing ${localFile} to ${preprocessedFile}`);
      await preprocessAudio(localFile, preprocessedFile);
      await fsPromises.access(preprocessedFile);
      await fsPromises.unlink(localFile);
      logger.debug(`Deleted original local file: ${localFile}`);
      preprocessedFiles.push(preprocessedFile);
    }

    let fullTranscript = [];
    let offset = 0;
    for (const localFile of preprocessedFiles) {
      let segments = [];
      let attempts = 0;
      const maxRetries = 3;
      while (attempts < maxRetries) {
        try {
          await fsPromises.access(localFile);
          const startTime = Date.now();
          const stream = fs.createReadStream(localFile);
          stream.on('error', (err) => {
            logger.error(`Stream error for ${localFile}:`, err);
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
          logger.debug(`Transcription for ${localFile} took ${Date.now() - startTime}ms: ${transcription.segments.length} segments`);
          segments = transcription.segments.filter(
            segment => segment.avg_logprob > -0.4 && segment.no_speech_prob < 0.4
          ).map(segment => ({
            text: segment.text,
            offset: (segment.start + offset) * 1000,
            duration: (segment.end - segment.start) * 1000
          }));
          offset += segments[segments.length - 1]?.end || 60;
          break;
        } catch (error) {
          attempts++;
          logger.error(`Transcription attempt ${attempts} failed for ${localFile}: ${error.message}`);
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
        } finally {
          if (fs.existsSync(localFile)) {
            await fsPromises.unlink(localFile);
            logger.debug(`Deleted local file: ${localFile}`);
          }
        }
      }
      fullTranscript.push(...segments);
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
        logger.debug(`Refined segment for ${item.text}: ${refinedSegment}`);
        return { ...item, text: refinedSegment };
      });
      logger.info(`Final transcript generated with ${finalTranscript.length} segments`);
      return finalTranscript;
    }

    throw new Error('No valid transcript found');
  } catch (error) {
    logger.error(`Whisper transcription failed for ${videoId}:`, error);
    throw new Error(`Failed to generate transcript: ${error.message}`);
  } finally {
    if (s3Uris.length > 0) {
      logger.debug(`Cleaning up ${s3Uris.length} S3 objects`);
      await cleanupAudio(s3Uris);
    }
    const localFiles = await fsPromises.readdir(outputDir).catch(() => []);
    await Promise.all(localFiles.map(async (file) => {
      if (file.includes(videoId) && (file.endsWith('.wav') || file.endsWith('.mp3'))) {
        try {
          await fsPromises.unlink(path.join(outputDir, file));
          logger.debug(`Deleted local file: ${file}`);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn(`Failed to delete local file ${file}:`, err.message);
          }
        }
      }
    }));
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
    logger.warn(`Transcript refinement failed: ${error.message}`);
    return rawText;
  }
}

module.exports = { fetchTranscript };