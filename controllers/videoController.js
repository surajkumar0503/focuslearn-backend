const { fetchVideoDetails } = require('../services/videoService');

const fetchVideo = async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: "No video ID provided" });

    const videoDetails = await fetchVideoDetails(videoId);
    if (!videoDetails) return res.status(404).json({ error: "Video not found" });

    res.json(videoDetails);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { fetchVideo };
