const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { logger } = require('../config/logger');

async function getGroqResponse({ videoId, query, transcript }) {
  logger.info(`Processing query "${query}" for video ${videoId}`);
  const maxRetries = 3;
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      if (!transcript?.length) {
        logger.error(`No transcript available for video ${videoId}`);
        throw new Error('No transcript available for query processing');
      }

      let context = transcript.map(item => item.text).join(' ');
      const maxTokenEstimate = 10000; // further reduced for long videos
      const words = context.split(/\s+/);
      if (words.length > maxTokenEstimate * 0.75) {
        logger.info(`Transcript for ${videoId} too long (${words.length} words), preprocessing`);
        if (query.toLowerCase().includes('summary') || query.toLowerCase().includes('key points')) {
          const keySentencesPrompt = `Extract 10-15 key sentences from the transcript: "${context.slice(0, 30000)}". Return as a concise list.`;
          const startTime = Date.now();
          const keySentencesResponse = await Promise.race([
            groq.chat.completions.create({
              messages: [
                { role: 'system', content: 'You are a summarization expert.' },
                { role: 'user', content: keySentencesPrompt }
              ],
              model: 'llama-3.3-70b-versatile',
              max_tokens: 500,
              temperature: 0.3
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Key sentences timeout')), 60000))
          ]);
          logger.info(`Key sentences extracted in ${Date.now() - startTime}ms`);
          context = keySentencesResponse.choices[0]?.message?.content || context.slice(0, maxTokenEstimate * 4);
        } else {
          context = context.slice(0, maxTokenEstimate * 4);
        }
        logger.info(`Truncated transcript to ${context.length} chars for ${videoId}`);
      }

      const prompt = query.toLowerCase().includes('key points')
        ? `Based on the transcript: "${context}", provide a list of 5-10 key points from the video. Each point should be concise and capture a main idea.`
        : query.toLowerCase().includes('summary')
        ? `Based on the transcript: "${context}", provide a concise summary of the video in 3-5 sentences. Focus on the main points and avoid unnecessary details.`
        : `Based on the transcript: "${context}", answer the query: "${query}". Provide a concise and accurate response.`;

      logger.info(`Sending Groq request for ${videoId}, attempt ${attempts + 1}`);
      const startTime = Date.now();
      const response = await Promise.race([
        groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: prompt }
          ],
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          temperature: 0.7
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Response timeout')), 120000))
      ]);
      logger.info(`Response received for ${videoId} in ${Date.now() - startTime}ms`);
      return response.choices[0]?.message?.content || 'No response generated';
    } catch (error) {
      attempts++;
      if (error.status === 429 || error.code === 'rate_limit_exceeded' || error.status === 503 || error.status === 500 || error.message.includes('timeout')) {
        const retryAfter = parseInt(error.headers?.['retry-after']) * 1000 || Math.pow(2, attempts) * 1000;
        logger.warn(`Retryable error for ${videoId}, retrying after ${retryAfter}ms (attempt ${attempts}): ${error.message}`);
        if (attempts >= maxRetries) {
          logger.error(`Max retries exceeded for ${videoId}: ${error.message}`);
          throw new Error('Rate limit or server error after maximum retries', {
            details: 'Please wait a few minutes and try again.'
          });
        }
        await new Promise(resolve => setTimeout(resolve, retryAfter));
      } else {
        logger.error(`Groq API error for ${videoId}: ${error.message}`);
        throw new Error(error.message || 'Failed to process query', {
          details: 'An unexpected error occurred.'
        });
      }
    }
  }
}

module.exports = { getGroqResponse };