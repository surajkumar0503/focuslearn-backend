const express = require('express');
const app = express();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { cleanEnv, str, port } = require('envalid');
require('dotenv').config();
const { logger } = require('./config/logger');

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
  AWS_S3_BUCKET: str()
});

app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:5173', 'https://focuslearntube.onrender.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type'],
  credentials: false 
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.url === '/fetch_video'  || req.url === '/fetch_playlist'
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));

connectDB();

app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));
app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);

app.use((err, req, res, next) => {
  logger.error(`Global error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

module.exports = { app, logger };