// src/middleware/idempotency.js
import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

const TTL_HOURS = 24;

function captureResponse(res, onCapture) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    onCapture(res.statusCode, body);
    return originalJson(body);
  };
}

function buildMiddleware(required) {
  return async function idempotencyMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();

    const key = req.headers['idempotency-key'];

    if (!key) {
      if (required) {
        return res.status(400).json({
          error: 'Missing Idempotency-Key header',
          message:
            'This endpoint requires an Idempotency-Key header to prevent duplicate operations. ' +
            'Generate a UUID and include it as: Idempotency-Key: <uuid>',
        });
      }
      return next();
    }

    if (typeof key !== 'string' || key.length > 255 || key.trim().length === 0) {
      return res.status(400).json({
        error: 'Invalid Idempotency-Key',
        message: 'Idempotency-Key must be a non-empty string under 255 characters.',
      });
    }

    try {
      const cutoff = new Date(Date.now() - TTL_HOURS * 60 * 60 * 1000).toISOString();

      const { data: existing, error: fetchError } = await supabase
        .from('idempotency_keys')
        .select('response_status, response_body, created_at')
        .eq('id', key)
        .gte('created_at', cutoff)
        .maybeSingle();

      if (fetchError) {
        logger.error('Idempotency key lookup failed', { error: fetchError.message });
        return next();
      }

      if (existing) {
        logger.info('Idempotency cache hit', { key: key.slice(0, 8) + '…' });
        res.setHeader('Idempotency-Replay', 'true');
        return res.status(existing.response_status).json(existing.response_body);
      }

      captureResponse(res, async (statusCode, body) => {
        if (statusCode < 500) {
          const { error: insertError } = await supabase
            .from('idempotency_keys')
            .insert({ id: key, response_status: statusCode, response_body: body });

          if (insertError) {
            logger.warn('Idempotency key insert failed', {
              key: key.slice(0, 8) + '…',
              error: insertError.message,
            });
          }
        }
      });

      next();
    } catch (err) {
      logger.error('Idempotency middleware error', { error: err.message });
      next();
    }
  };
}

export const requireIdempotency = buildMiddleware(true);
export const optionalIdempotency = buildMiddleware(false);