const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  videoId: { type: String, default: "" }, // videoId optional
  content: { type: String, required: true },
  title: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Note", noteSchema);