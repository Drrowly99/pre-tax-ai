import logger from '../utils/logger.js';
import { supabase } from '../utils/supabase.js';

/**
 * Idempotency Middleware
 * Prevents duplicate operations from retried requests
 *
 * CREATE TABLE idempotency_keys (
 *   id TEXT PRIMARY KEY,
 *   response_status INTEGER,
 *   response_body JSONB,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
 */

const IDEMPOTENCY_TTL_HOURS = 24;
const REQUIRED_ROUTES = new Set([
  'POST:/api/jobs',
  'POST:/api/jobs/:jobId/run-analysis',
  'POST:/api/jobs/:jobId/publish',
  'POST:/api/stripe/deposit-webhook',
  'POST:/api/stripe/balance-webhook'
]);

/**
 * Check if route requires idempotency
 */
function isRequiredRoute(method, path) {
  const normalizedPath = path.split('?')[0]; // Remove query string
  const routeKey = `${method}:${normalizedPath}`;

  // Check exact match first
  if (REQUIRED_ROUTES.has(routeKey)) return true;

  // Check pattern match for :jobId routes
  if (normalizedPath.includes('/api/jobs/') && normalizedPath.includes('/')) {
    const jobIdPattern = '/api/jobs/:jobId';
    return REQUIRED_ROUTES.has(`${method}:${jobIdPattern}/run-analysis`) ||
           REQUIRED_ROUTES.has(`${method}:${jobIdPattern}/publish`);
  }

  return false;
}

/**
 * Middleware factory: requires idempotency key
 */
export function requireIdempotency(req, res, next) {
  const idempotencyKey = req.get('Idempotency-Key');

  // Only enforce on specific routes
  if (!isRequiredRoute(req.method, req.path)) {
    return next();
  }

  // GET requests never require idempotency
  if (req.method === 'GET') {
    return next();
  }

  // Check for header
  if (!idempotencyKey) {
    logger.warn(`Missing Idempotency-Key on ${req.method} ${req.path}`);
    return res.status(400).json({
      error: 'Idempotency-Key header is required for this operation',
      code: 'MISSING_IDEMPOTENCY_KEY'
    });
  }

  // Validate format (UUID-like)
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return res.status(400).json({
      error: 'Idempotency-Key must be a valid UUID',
      code: 'INVALID_IDEMPOTENCY_KEY'
    });
  }

  // Attach to request for handler
  req.idempotencyKey = idempotencyKey;

  // Cache the response
  return cacheResponse(req, res, next);
}

/**
 * Middleware factory: optional idempotency (caches if key present)
 */
export function optionalIdempotency(req, res, next) {
  const idempotencyKey = req.get('Idempotency-Key');

  // Get requests never need caching
  if (req.method === 'GET') {
    return next();
  }

  if (!idempotencyKey) {
    // No key provided — pass through
    return next();
  }

  if (!isValidIdempotencyKey(idempotencyKey)) {
    // Invalid key — treat as no key
    return next();
  }

  req.idempotencyKey = idempotencyKey;
  return cacheResponse(req, res, next);
}

/**
 * Core cache implementation
 */
async function cacheResponse(req, res, next) {
  const idempotencyKey = req.idempotencyKey;

  try {
    // Check if we've seen this key before
    const { data: cached, error: fetchError } = await supabase
      .from('idempotency_keys')
      .select('response_status, response_body, created_at')
      .eq('id', idempotencyKey)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = no rows (expected for new keys)
      logger.error(`Idempotency lookup error: ${fetchError.message}`);
      return next(); // Proceed without cache on error
    }

    if (cached) {
      // Key exists — check if expired (> 24 hours)
      const createdAt = new Date(cached.created_at);
      const now = new Date();
      const ageHours = (now - createdAt) / (1000 * 60 * 60);

      if (ageHours <= IDEMPOTENCY_TTL_HOURS) {
        // Cached response still valid
        logger.info(`Returning cached idempotent response for key ${idempotencyKey}`);
        return res.status(cached.response_status).json(cached.response_body);
      }

      // Cache expired — continue with fresh request and update cache
    }

    // New key or expired — intercept response
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = function(body) {
      // Cache the response
      const status = res.statusCode;
      cacheIdempotentResponse(idempotencyKey, status, body).catch(err => {
        logger.error(`Failed to cache idempotent response: ${err.message}`);
      });

      return originalJson(body);
    };

    res.send = function(body) {
      // For non-JSON responses
      const status = res.statusCode;
      const parsed = typeof body === 'string' ? { message: body } : body;
      cacheIdempotentResponse(idempotencyKey, status, parsed).catch(err => {
        logger.error(`Failed to cache idempotent response: ${err.message}`);
      });

      return originalSend(body);
    };

    next();
  } catch (err) {
    logger.error(`Idempotency middleware error: ${err.message}`);
    next(); // Proceed without cache on unexpected error
  }
}

/**
 * Store idempotent response in Supabase
 */
async function cacheIdempotentResponse(key, status, body) {
  try {
    // Try to insert; if key exists, update it
    const { error } = await supabase
      .from('idempotency_keys')
      .upsert({
        id: key,
        response_status: status,
        response_body: body,
        created_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      });

    if (error) {
      logger.warn(`Failed to cache idempotent response: ${error.message}`);
    }
  } catch (err) {
    logger.error(`Idempotency cache error: ${err.message}`);
  }
}

/**
 * Validate idempotency key format (UUID)
 */
function isValidIdempotencyKey(key) {
  // Accept UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // Or any non-empty string up to 255 chars (relaxed validation)
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > 255) return false;
  // Alphanumeric, hyphens, underscores only
  return /^[a-zA-Z0-9_-]+$/.test(key);
}

export default { requireIdempotency, optionalIdempotency };
