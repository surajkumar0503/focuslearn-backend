const express = require('express');
const app = express();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { cleanEnv, str, port } = require('envalid');
require('dotenv').config();
const winston = require('winston');

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

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 20, // limit each IP to 20 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); 

// connect MongoDB
connectDB();

// API Routes
app.use('/', videoRoutes);
app.use('/', playlistRoutes);
app.use('/', queryRoutes);
app.use('/', noteRoutes);

// error handling
app.use((err, req, res, next) => {
  logger.error(`Global error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
});

server.keepAliveTimeout = 120000; 
server.headersTimeout = 120000; 