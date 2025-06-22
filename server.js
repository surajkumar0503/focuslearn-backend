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

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

connectDB();

app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);


app.use((err, req, res, next) => {
  if (err instanceof EnhancedError) {
    logger.error(`Enhanced Error: ${err.message}`, {
      originalError: err.originalError.message,
      context: err.context
    });
    
    if (err.originalError.message.includes('rate limit')) {
      return res.status(429).json({
        error: 'YouTube rate limit reached',
        details: 'Our system has hit YouTube download limits',
        solution: 'Please try again in a few hours',
        retryAfter: '3600' 
      });
    }
  }

  if (err.message.includes('unavailable') || 
      err.message.includes('private') ||
      err.message.includes('restricted')) {
    logger.warn(`Content restriction: ${err.message}`);
    return res.status(403).json({
      error: 'Video unavailable',
      details: 'This video may be age-restricted, private, or blocked',
      solution: 'Try a different video or check availability'
    });
  }

  if (err.message.includes('File too small')) {
    logger.error(`Download verification failed: ${err.message}`);
    return res.status(502).json({
      error: 'Download incomplete',
      details: 'The audio download did not complete successfully',
      solution: 'Please try again'
    });
  }


  logger.error(`Server Error: ${err.stack}`);
  res.status(500).json({
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { 
      details: err.message,
      stack: err.stack 
    })
  });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;