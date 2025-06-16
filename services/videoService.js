const axios = require('axios');
const VideoMetadata = require('../models/VideoMetadata');

async function fetchVideoDetails(videoId) {
  try {
    const cached = await VideoMetadata.findOne({ videoId });
    if (cached) return cached;

    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet',
        id: videoId,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    const video = response.data.items[0]?.snippet;
    if (!video) throw new Error('Video not found');

    const metadata = {
      videoId,
      title: video.title,
      description: video.description
    };

    await VideoMetadata.create(metadata);
    return metadata;
  } catch (error) {
    console.error('YouTube API error:', error);
    throw new Error('Failed to fetch video details');
  }
}

async function getVideoTitle(videoId) {
  const details = await fetchVideoDetails(videoId);
  return details?.title || null;
}

module.exports = { fetchVideoDetails, getVideoTitle };