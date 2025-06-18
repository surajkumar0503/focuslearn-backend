const axios = require('axios');
const { logger } = require('../config/logger');

async function fetchVideoDetails(videoId) {
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet',
        id: videoId,
        key: process.env.YOUTUBE_API_KEY
      }
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
    logger.error(`YouTube API error: ${error.message}`);
    throw new Error('Failed to fetch video details');
  }
}

module.exports = { fetchVideoDetails };