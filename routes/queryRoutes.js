const express = require('express');
const { answerQuery } = require('../controllers/queryController');
const router = express.Router();

router.post('/answer_query', answerQuery);

module.exports = router;