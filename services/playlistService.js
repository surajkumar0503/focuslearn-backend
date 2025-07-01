const axios = require('axios');

async function getPlaylistDetails(playlistId) {
  const maxRetries = 3;
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50&key=${process.env.YOUTUBE_API_KEY}`;
      const response = await axios.get(url);
      const playlistData = response.data;

      if (!playlistData.items || playlistData.items.length === 0) {
        return null;
      }

      return playlistData.items.map(item => ({
        id: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.default.url
      }));
    } catch (error) {
      attempts++;
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers?.['retry-after'] || 5;
        console.warn(`YouTube API rate limit, retrying after ${retryAfter}s (attempt ${attempts})`);
        if (attempts >= maxRetries) {
          console.error('YouTube API rate limit exceeded after maximum retries');
          return null;
        }
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else if (error.response?.status === 403 && error.response.data.error.code === 403) {
        console.error('YouTube API quota exceeded');
        return null;
      } else {
        console.error('Error fetching playlist details:', error);
        return null;
      }
    }
  }
}

module.exports = { getPlaylistDetails };
