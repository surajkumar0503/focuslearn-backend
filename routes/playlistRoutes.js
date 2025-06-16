const express = require('express');
const { fetchPlaylist } = require('../controllers/playlistController');
const router = express.Router();

router.post('/fetch_playlist', fetchPlaylist);

module.exports = router;
