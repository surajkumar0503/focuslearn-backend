const axios = require('axios');
const winston = require('winston');

const { logger } = require('../config/logger');

async function fetchVideoDetails(videoId) {
  try {
    const response = await axios.get('https://142.250.190.78/youtube/v3/videos', {
      params: {
        part: 'snippet',
        id: videoId,
        key: process.env.YOUTUBE_API_KEY
      },
      headers: { Host: 'www.googleapis.com' } // Spoof host header
    });
    if (response.data.items.length === 0) {
      throw new Error('Video not found');
    }
    const videoDetails = response.data.items[0].snippet;
    return {
      title: videoDetails.title,
      description: videoDetails.description,
      thumbnail: videoDetails.thumbnails?.medium?.url
    };
  } catch (error) {
    logger.error(`YouTube API error:`, error);
    throw new Error('Failed to fetch video details');
  }
}

module.exports = { fetchVideoDetails };