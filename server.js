const express = require('express');
const app = express();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { cleanEnv, str, port } = require('envalid');
const { logger } = require('./config/logger');
const PORT = process.env.PORT || 5000;
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
});


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 50, 
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(cors());
app.use(express.json({ limit: '10mb' })); 

connectDB();

app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);

app.use((err, req, res, next) => {
  logger.error(`Global error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running in ${process.env.NODE_ENV || 'undefined'} mode on port ${PORT}`);
});

server.keepAliveTimeout = 120000; 
server.headersTimeout = 120000; 