const mongoose = require('mongoose');

const videoMetadataSchema = new mongoose.Schema({
  videoId: { type: String, required: true, unique: true },
  title: String,
  description: String,
  createdAt: { type: Date, default: Date.now, index: { expires: '30d' } }
});

module.exports = mongoose.model('VideoMtadata', videoMetadataSchema);
