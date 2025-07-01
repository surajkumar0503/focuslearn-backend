const { answerQuery } = require('../utils/queryHelper'); 

const answerQueryController = async (req, res) => {
  const { videoId, query } = req.body;

  try {
    const { content, transcriptAvailable } = await answerQuery(query, videoId);
    res.status(200).json({ response: content, transcriptAvailable });
  } catch (error) {
    console.error('Error answering query:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
};

module.exports = { answerQuery: answerQueryController };
