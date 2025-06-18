const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  videoId: { type: String, default: '' },
  title: { type: String, default: '' },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Note', noteSchema);