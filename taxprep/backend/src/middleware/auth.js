// src/middleware/auth.js
// Worker authentication middleware.
//
// Token format:  base64(name:password)
// Header format: Authorization: Bearer <token>
//
// Workers are configured entirely via environment variables — no database
// lookups needed. This keeps auth fast and dependency-free.
//
// On success, sets req.worker = { id: 'worker_1', name: 'Alice', index: 1 }
// On failure, returns 401 immediately.

import logger from '../utils/logger.js';

/**
 * Build the worker registry from environment variables.
 * Returns a Map keyed by lowercase name for O(1) lookup.
 *
 * Reads: WORKER_1_NAME / WORKER_1_PASSWORD … WORKER_5_NAME / WORKER_5_PASSWORD
 */
function buildWorkerRegistry() {
  const registry = new Map(); // key: lowercase name → value: worker record

  for (let i = 1; i <= 5; i++) {
    const name = process.env[`WORKER_${i}_NAME`];
    const password = process.env[`WORKER_${i}_PASSWORD`];

    if (name && password) {
      registry.set(name.toLowerCase(), {
        id: `worker_${i}`,
        name,         // original casing
        index: i,
        password,     // never sent to clients
      });
    }
  }

  return registry;
}

// Build once at module load — env vars don't change at runtime
const WORKER_REGISTRY = buildWorkerRegistry();

/**
 * Decode and validate a Bearer token.
 * Returns the matching worker record, or null on any failure.
 *
 * @param {string} authHeader - The raw Authorization header value
 */
function resolveWorker(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  let decoded;
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // Expect exactly "name:password" — split on first colon only
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return null;

  const name = decoded.slice(0, colonIndex);
  const password = decoded.slice(colonIndex + 1);

  if (!name || !password) return null;

  const worker = WORKER_REGISTRY.get(name.toLowerCase());
  if (!worker) return null;

  // Constant-time comparison is ideal but workers are internal staff,
  // not public users, so simple equality is acceptable here.
  if (worker.password !== password) return null;

  return worker;
}

/**
 * Express middleware — protects any route that requires a logged-in worker.
 * Attaches req.worker on success.
 */
function requireWorkerAuth(req, res, next) {
  const worker = resolveWorker(req.headers.authorization);

  if (!worker) {
    logger.warn('Unauthorized access attempt', {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
    return res.status(401).json({
      error: 'Unauthorized. Provide a valid Bearer token.',
    });
  }

  req.worker = {
    id: worker.id,
    name: worker.name,
    index: worker.index,
    // password intentionally excluded
  };

  next();
}

/**
 * Helper used by tests and other services.
 * Returns the full worker list (names + ids only — no passwords).
 */
function getWorkers() {
  return Array.from(WORKER_REGISTRY.values()).map(({ id, name, index }) => ({
    id,
    name,
    index,
  }));
}

/**
 * Helper: check if a given worker id (e.g. 'worker_2') is valid.
 */
function isValidWorkerId(id) {
  return Array.from(WORKER_REGISTRY.values()).some(w => w.id === id);
}

export { requireWorkerAuth, getWorkers, isValidWorkerId, resolveWorker };