const { ChatGroq } = require('@langchain/groq');
const { HumanMessage } = require('@langchain/core/messages');
const { fetchTranscript } = require('../services/transcriptService');
const { fetchVideoDetails } = require('../services/videoService');
const { formatTranscript, summarizeTranscript } = require('./formatters');

const answerQuery = async (query, video_id) => {
  if (!query || !video_id) {
    const error = new Error("Query and video_id are required");
    error.status = 400;
    throw error;
  }

  console.log(`Processing query: "${query}" for video_id: ${video_id}`);

  try {
    // fetch transcript and video details
    const transcript = await fetchTranscript(video_id);
    const videoDetails = await fetchVideoDetails(video_id);
    const title = videoDetails?.title || `Video ID: ${video_id}`;

    // limit transcript to 2000 characters for context
    const formattedTranscript = transcript ? formatTranscript(transcript) : null;
    const summarizedTranscript = formattedTranscript
      ? summarizeTranscript(formattedTranscript.slice(0, 2000))
      : null;
    const transcriptAvailable = !!transcript;
    console.log(`Transcript available: ${transcriptAvailable}`);

    // prepare prompt
    const systemMessage = new HumanMessage(
      "You are a helpful assistant that answers user queries based on the given input query " +
      "if video length is long then always provide maximum words response answer. " +
      "For queries requesting key points or important points, provide answer in the form of points which will be important " +
      "For queries requesting a summary, provide a detailed overview " +
      "of the video's content, including key points, main topics, and examples, in 3-5 paragraphs. " +
      "For other queries, provide a precise, detailed, and concise response using the transcript as the " 
    );

    const humanMessage = new HumanMessage(
      `Title: ${title}\nTranscript: ${summarizedTranscript || 'Not available'}\nQuery: ${query}`
    );

    // initialize primary model
    const llm = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      maxTokens: 1000,
    });

    // try primary model
    let response;
    try {
      response = await llm.invoke([systemMessage, humanMessage]);
    } catch (error) {
      if (error.status === 429 || error.message.includes('rate limit')) {
        console.log('Rate limit hit for llama-3.3-70b-versatile, trying mixtral-8x7b-32768');
        const fallbackLlm = new ChatGroq({
          apiKey: process.env.GROQ_API_KEY,
          model: "mixtral-8x7b-32768",
          temperature: 0.7,
          maxTokens: 1000,
        });
        try {
          response = await fallbackLlm.invoke([systemMessage, humanMessage]);
        } catch (fallbackError) {
          if (fallbackError.status === 429 || fallbackError.message.includes('rate limit')) {
            const retryAfter = fallbackError.headers?.["retry-after"] || "3600";
            const error = new Error(
              `Rate limit reached for all models. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`
            );
            error.status = 429;
            error.retryAfter = retryAfter;
            throw error;
          }
          throw fallbackError;
        }
      } else {
        throw error;
      }
    }

    const content = response.content || "";
    console.log(`Response content: ${content}`);

    if (!content) {
      const error = new Error("No content returned from AI model");
      error.status = 500;
      throw error;
    }

    return {
      content,
      transcriptAvailable,
    };
  } catch (error) {
    console.error("Error processing query:", error);
    if (error.status === 429) {
      error.message = `Rate limit reached. Please try again in ${Math.ceil(error.retryAfter / 60)} minutes.`;
    }
    throw error;
  }
};

module.exports = { answerQuery };