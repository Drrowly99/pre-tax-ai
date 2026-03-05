// src/routes/auth.js
// Worker authentication routes.
//
// POST /api/auth/login    — exchange name+password for a Bearer token
// GET  /api/auth/me       — validate token + return current worker info
// GET  /api/auth/workers  — list all configured workers (auth required)
//
// Token strategy: base64(name:password)
// No expiry — workers change passwords via env vars + redeploy.
// No refresh tokens needed — this is an internal tool.

import { Router } from 'express';
import { requireWorkerAuth, getWorkers, resolveWorker } from '../middleware/auth.js';
import { validateBody, Schemas } from '../middleware/validate.js';
import logger from '../utils/logger.js';

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Exchange { name, password } for a Bearer token.
// Rate limited to 10 attempts/hour by server.js (loginLimiter).

router.post('/login', validateBody(Schemas.login), (req, res) => {
  const { name, password } = req.body;

  // Build the token and attempt to resolve it through the same path
  // that the auth middleware uses — single source of truth.
  const token = Buffer.from(`${name}:${password}`).toString('base64');
  const worker = resolveWorker(`Bearer ${token}`);

  if (!worker) {
    logger.warn('Failed login attempt', { ip: req.ip });
    // Same message for wrong name OR wrong password — don't reveal which
    return res.status(401).json({ error: 'Invalid name or password.' });
  }

  logger.info('Worker logged in', { workerId: worker.id });

  return res.status(200).json({
    data: {
      token,
      worker: {
        id:    worker.id,
        name:  worker.name,
        index: worker.index,
      },
    },
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Validate the current Bearer token and return the worker record.
// Useful for the frontend to rehydrate auth state on page load.

router.get('/me', requireWorkerAuth, (req, res) => {
  return res.status(200).json({
    data: {
      worker: req.worker,
    },
  });
});

// ── GET /api/auth/workers ─────────────────────────────────────────────────────
// Return all configured workers (names + IDs only — never passwords).
// Used to populate assignment dropdowns in the UI.

router.get('/workers', requireWorkerAuth, (req, res) => {
  return res.status(200).json({
    data: {
      workers: getWorkers(),
    },
  });
});

export default router;