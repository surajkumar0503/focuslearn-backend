const { getPlaylistDetails } = require('../services/playlistService');

const fetchPlaylist = async (req, res) => {
  try {
    const { playlistId } = req.body;
    if (!playlistId) return res.status(400).json({ error: "No playlist ID provided" });

    const playlistDetails = await getPlaylistDetails(playlistId);
    if (!playlistDetails) return res.status(404).json({ error: "Playlist not found" });

    res.json({ videos: playlistDetails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { fetchPlaylist };