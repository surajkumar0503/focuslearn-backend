const { YoutubeTranscript } = require('youtube-transcript');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const Transcript = require('../models/Transcript');
const { fetchVideoDetails } = require('./videoService');
const { logger } = require('../config/logger');

async function fetchTranscript(videoId, language = 'en') {
  try {
    const cached = await Transcript.findOne({ videoId });
    if (cached) {
      logger.info(`Using cached transcript for ${videoId}`);
      return cached.transcript;
    }

    let transcript;
    try {
      transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: language });
      logger.info(`Public transcript fetched for ${videoId} in language ${language}`);
    } catch (error) {
      logger.warn(`No transcript in ${language} for ${videoId}, trying fallback languages...`);
      const fallbackLangs = ['ta', 'hi', 'en'];
      for (const lang of fallbackLangs) {
        try {
          transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
          logger.info(`Public transcript fetched for ${videoId} in fallback language ${lang}`);
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

    // production check
    const isProduction = process.env.NODE_ENV === 'production';
    logger.info(`Is production mode: ${isProduction}`);
    if (isProduction) {
      logger.info(`Public transcript unavailable for ${videoId} in production, skipping Whisper generation`);
      return null; 
    }

    // development mode
    logger.warn(`Public transcript unavailable for ${videoId}, attempting Whisper generation`);
    try {
      logger.info(`Entering generateWhisperTranscript for ${videoId}`);
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
  } catch (error) {
    logger.warn(`Error fetching transcript for ${videoId}: ${error.message}`);
    const isProduction = process.env.NODE_ENV === 'production';
    logger.info(`Is production mode (error path): ${isProduction}`);
    if (isProduction) {
      logger.info(`Returning null transcript in production for ${videoId}`);
      return null;
    }
    throw new Error('Failed to fetch or generate transcript');
  }
}

async function generateWhisperTranscript(videoId, language) {
  const { extractAudio, cleanupAudio } = require('../utils/audioExtractor');
  const { preprocessAudio } = require('../utils/audioPreprocessor');
  const fs = require('fs');
  const fsPromises = require('fs').promises;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let audioChunks = [];
  let preprocessedChunks = [];

  try {
    logger.info(`Fetching video details for ${videoId}`);
    const videoDetails = await fetchVideoDetails(videoId);
    const prompt = videoDetails?.title || '';
    logger.info(`Video title: ${prompt}`);

    logger.info(`Extracting audio for ${videoUrl}`);
    audioChunks = await extractAudio(videoUrl);
    logger.info(`Extracted ${audioChunks.length} audio chunks`);

    // filter chunks to include only those for the current videoId
    audioChunks = audioChunks.filter(chunk => chunk.includes(`audio_${videoId}_`));
    logger.info(`Filtered to ${audioChunks.length} chunks for ${videoId}: ${audioChunks.join(', ')}`);

    const preprocessPromises = audioChunks.map(async (chunk) => {
      if (chunk.includes('_preprocessed')) return chunk;
      const preprocessedFile = chunk.replace('.wav', '_preprocessed.wav');
      logger.info(`Preprocessing ${chunk} to ${preprocessedFile}`);
      try {
        await preprocessAudio(chunk, preprocessedFile);
        await fsPromises.access(preprocessedFile); 
        return preprocessedFile;
      } catch (error) {
        logger.error(`Preprocessing failed for ${chunk}:`, error);
        throw new Error(`Audio preprocessing failed: ${error.message}`);
      }
    });
    preprocessedChunks = await Promise.all(preprocessPromises);
    logger.info(`Preprocessed ${preprocessedChunks.length} chunks`);

    let fullTranscript = [];
    let offset = 0;
    for (const chunk of preprocessedChunks) {
      logger.info(`Transcribing chunk ${chunk}`);
      let attempts = 0;
      const maxRetries = 3;
      while (attempts < maxRetries) {
        try {
          // verify file exists before transcription
          await fsPromises.access(chunk);
          const startTime = Date.now();
          const stream = fs.createReadStream(chunk);
          stream.on('error', (err) => {
            logger.error(`Stream error for ${chunk}:`, err);
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
            new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timeout')), 60000)) // 60-second timeout
          ]);
          logger.info(`Transcription for ${chunk} took ${Date.now() - startTime}ms: ${transcription.segments.length} segments`);
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
          offset += segments[segments.length - 1]?.end || 60; // match segment_time
          break;
        } catch (error) {
          attempts++;
          logger.error(`Transcription attempt ${attempts} failed for ${chunk}: ${error.message}`);
          if (error.status === 429 || error.message.includes('rate_limit') || error.message === 'Transcription timeout') {
            const retryAfter = parseInt(error.headers?.['retry-after']) * 1000 || Math.pow(2, attempts) * 1000;
            logger.warn(`Retryable error, retrying after ${retryAfter}ms`);
            if (attempts >= maxRetries) {
              throw new Error(`Transcription failed after ${maxRetries} retries: ${error.message}`);
            }
            // verify file still exists before retry
            try {
              await fsPromises.access(chunk);
            } catch (err) {
              logger.error(`File ${chunk} missing before retry:`, err);
              throw new Error(`Audio file missing: ${err.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, retryAfter));
          } else {
            throw new Error(`Whisper transcription failed: ${error.message}`);
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
    // cleanup after all transcription attempts
    if (audioChunks.length > 0 || preprocessedChunks.length > 0) {
      logger.info(`Cleaning up ${audioChunks.length + preprocessedChunks.length} audio files`);
      await cleanupAudio([...audioChunks, ...preprocessedChunks]);
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Refinement timeout')), 60000)) // 60-second timeout
    ]);
    logger.info(`Refined transcript received`);
    return response.choices[0]?.message?.content || rawText;
  } catch (error) {
    logger.error('Transcript refinement failed:', error);
    return rawText; // fallback to raw text
  }
}

module.exports = { fetchTranscript };