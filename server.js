const express = require('express');
const app = express();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { cleanEnv, str, port } = require('envalid');
const { logger } = require('./config/logger');
require('dotenv').config();

const videoRoutes = require('./routes/videoRoutes');
const playlistRoutes = require('./routes/playlistRoutes');
const queryRoutes = require('./routes/queryRoutes');
const noteRoutes = require('./routes/noteRoutes');

const env = cleanEnv(process.env, {
  PORT: port({ default: 5000 }),
  MONGODB_URI: str(),
  GROQ_API_KEY: str(),
  YOUTUBE_API_KEY: str(),
  YT_PROXY: str({ default: '' }),
  USE_YOUTUBE_COOKIES: str({ default: 'false' }),
  AWS_S3_BUCKET: str({ default: 'focuslearn-audio-2025' })
});

// Enhanced rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Rate limit exceeded',
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

connectDB();

// Routes
app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);

// Enhanced error handling
app.use((err, req, res, next) => {
  if (err.message.includes('rate limit')) {
    logger.warn(`Rate limit error: ${err.message}`);
    return res.status(429).json({ 
      error: 'YouTube rate limit reached',
      solution: 'Please try again later or use YouTube API key'
    });
  }
  
  if (err.message.includes('unavailable') || err.message.includes('private')) {
    logger.warn(`Content unavailable: ${err.message}`);
    return res.status(403).json({
      error: 'Video unavailable',
      details: 'This video may be age-restricted or private'
    });
  }

  logger.error(`Server error: ${err.stack}`);
  res.status(500).json({ 
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: err.message })
  });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;