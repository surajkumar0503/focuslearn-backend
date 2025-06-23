const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { cleanEnv, str, port } = require('envalid');
const { logger } = require('./config/logger');
require('dotenv.config');

const videoRoutes = require('./routes/videoRoutes');
const playlistRoutes = require('./routes/playlistRoutes');
const queryRoutes = require('./routes/queryRoutes');
const noteRoutes = require('./routes/noteRoutes');

const env = cleanEnv(process.env, {
    PORT: port({ default: 5000 }),
    MONGODB_URI: str(),
    GROQ_API_KEY: str(),
    YOUTUBE_API_KEY: str(),
    AWS_ACCESS_KEY_ID: str(),
    AWS_SECRET_ACCESS_KEY: str(),
    AWS_REGION: str(),
    S3_BUCKET: str(),
});

const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // Higher limit for Lambda
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(cors({
  origin: 'https://focuslearntube.onrender.com',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '10mb'} ));

connectDB();

app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);

// Error handling
app.use((err, req, res, next) => {
  logger.error(`Global error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

module.exports.handler = serverless(app);