const express = require('express');
const { saveNote, getNotes, deleteNote, updateNote } = require('../controllers/noteController');
const router = express.Router();

router.post('/notes', saveNote);
router.post('/save_note', saveNote);// backward compatibility
router.get('/notes', getNotes);
router.delete('/notes/:id', deleteNote);
router.put('/notes/:id', updateNote);

module.exports = router;