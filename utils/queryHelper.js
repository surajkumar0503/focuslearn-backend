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
    const description = videoDetails?.description || '';

    // handle transcript availability
    let formattedTranscript = null;
    let summarizedTranscript = null;
    const transcriptAvailable = !!transcript;

    if (transcriptAvailable) {
      formattedTranscript = formatTranscript(transcript);
      summarizedTranscript = summarizeTranscript(formattedTranscript.slice(0, 2000));
    }

    console.log(`Transcript available: ${transcriptAvailable}`);

    // prompt based on transcript availability
    const systemMessageContent = transcriptAvailable
      ? "You are a helpful assistant that answers user queries based on the given input query " +
        "if video length is long then always provide maximum words response answer. " +
        "For queries requesting key points or important points, provide answer in the form of points which will be important " +
        "For queries requesting a summary, provide a detailed overview " +
        "of the video's content, including key points, main topics, and examples, in 3-5 paragraphs. " +
        "For other queries, provide a precise, detailed, and concise response using the transcript as the " +
        "primary source."
      : "You are a helpful assistant that answers user queries based on the given input query. " +
        "Since the transcript is unavailable, use the video title and description to provide a detailed and relevant answer. " +
        "For queries requesting key points or important points, provide a list of inferred points based on the title and description. " +
        "For queries requesting a summary, provide a concise overview inferred from the title and description in 2-3 paragraphs. " +
        "For other queries, provide a precise and detailed response inferred from the title and description.";

    const systemMessage = new HumanMessage(systemMessageContent);

    const humanMessageContent = transcriptAvailable
      ? `Title: ${title}\nTranscript: ${summarizedTranscript || 'Not available'}\nQuery: ${query}`
      : `Title: ${title}\nDescription: ${description}\nQuery: ${query}`;

    const humanMessage = new HumanMessage(humanMessageContent);

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
