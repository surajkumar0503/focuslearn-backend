const mongoose = require('mongoose');

const transcriptSchema = new mongoose.Schema({
  videoId: { type: String, required: true, unique: true },
  transcript: [
    {
      text: String,
      offset: Number,
      duration: Number
    }
  ],
  createdAt: { type: Date, default: Date.now, index: { expires: '30d' } } //explicit TTL index
});

module.exports = mongoose.model('Transcript', transcriptSchema);