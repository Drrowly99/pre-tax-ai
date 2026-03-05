// src/server.js
// TaxPrep Pro — Backend API Server
// All business logic, AI, security, and data lives here.
// Returns JSON only — never renders HTML.

import 'dotenv/config';
import 'express-async-errors'; // Catches async errors in route handlers

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import hpp from 'hpp';
import logger from './utils/logger.js';

import authRoutes from './routes/auth.js';
import jobRoutes from './routes/jobs.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── SECURITY MIDDLEWARE ───────────────────────────────────────────────────────

// Helmet sets safe HTTP headers
app.use(helmet({
  crossOriginEmbedderPolicy: false, // Allow embedded resources from frontend
}));

// CORS — only allow requests from our frontend
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5500', // For local dev with Live Server
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Body parsing — JSON and URL-encoded
app.use(express.json({ limit: '1mb' })); // Strict limit on JSON body size
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────

// General API rate limit — 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Login rate limit — 10 attempts per hour per IP
const loginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in an hour.' },
});

// AI pipeline trigger — max 5 per hour per IP (expensive operation)
const pipelineLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'AI analysis limit reached. Max 5 per hour.' },
});

// Slow down repeated requests (adds delay after 50 requests)
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 50,
  delayMs: () => 500,
});

app.use('/api/', generalLimiter);
app.use('/api/', speedLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/jobs/:jobId/run-analysis', pipelineLimiter);

// ── REQUEST LOGGING ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')?.slice(0, 50),
  });
  next();
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TaxPrep Pro API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);

// ── 404 HANDLER ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────────
// Catches all async errors thrown in route handlers (express-async-errors)
app.use((err, req, res, next) => {
  // Multer file upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `File too large. Maximum size is ${process.env.MAX_UPLOAD_SIZE_MB || 50}MB.`,
    });
  }

  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }

  // Log unexpected errors (never log PII)
  logger.error('Unhandled error', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  // Don't leak error details in production
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Our team has been notified.'
      : err.message,
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`TaxPrep Pro API running on port ${PORT}`, {
    env: process.env.NODE_ENV,
    frontend: process.env.FRONTEND_URL,
  });
});

export default app;