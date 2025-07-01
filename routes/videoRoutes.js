const express = require('express');
const { fetchVideo } = require('../controllers/videoController');
const router = express.Router();

router.post('/fetch_video', fetchVideo);

module.exports = router;