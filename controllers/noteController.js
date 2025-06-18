const mongoose = require('mongoose');
const Note = require('../models/Note');
const sanitize = require('sanitize-html');
const { logger } = require('../config/logger');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const saveNote = async (req, res) => {
  try {
    const { videoId, content, title = "" } = req.body;
    const sanitizedContent = sanitize(content, {
      allowedTags: [],
      allowedAttributes: {}
    });
    const sanitizedTitle = sanitize(title, {
      allowedTags: [],
      allowedAttributes: {}
    });
    if (!sanitizedContent) {
      return res.status(400).json({ error: "Content is required" });
    }
    const note = new Note({ videoId: videoId || "", content: sanitizedContent, title: sanitizedTitle });
    await note.save();
    res.status(201).json({ message: "Note created successfully", note });
  } catch (err) {
    logger.error(`Error saving note: ${err.message}`);
    res.status(500).json({ error: "Failed to save note", details: err.message });
  }
};

const getNotes = async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 }).lean();
    if (!notes) {
      return res.status(404).json({ error: "No notes found" });
    }
    res.status(200).json(notes);
  } catch (err) {
    logger.error(`Error fetching notes: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch notes", details: err.message });
  }
};

const deleteNote = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid note ID" });
    }
    const note = await Note.findByIdAndDelete(id);
    if (!note) {
      return res.status(404).json({ error: "Note not found" });
    }
    res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    logger.error(`Error deleting note: ${err.message}`);
    res.status(500).json({ error: "Failed to delete note", details: err.message });
  }
};

const updateNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { videoId, content, title } = req.body;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid note ID" });
    }
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    const note = await Note.findByIdAndUpdate(
      id,
      { videoId: videoId || "", content, title, createdAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!note) {
      return res.status(404).json({ error: "Note not found" });
    }
    res.status(200).json({ message: "Note updated successfully", note });
  } catch (err) {
    logger.error(`Error updating note: ${err.message}`);
    res.status(500).json({ error: "Failed to update note", details: err.message });
  }
};

module.exports = { saveNote, getNotes, deleteNote, updateNote };