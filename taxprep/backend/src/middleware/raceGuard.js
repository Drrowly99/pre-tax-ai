// src/middleware/raceGuard.js
// Distributed lock to prevent race conditions on critical operations.
// Uses Supabase as the lock store — safe across multiple server instances.

import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

const LOCK_TTL_MINUTES = 10;

/**
 * Acquire a distributed lock for a job.
 * Returns true if lock acquired, false if already locked.
 */
export async function acquireLock(jobId, operation, lockedBy) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MINUTES * 60 * 1000).toISOString();

  const { data: existing, error: fetchError } = await supabase
    .from('job_locks')
    .select('locked_by, operation, expires_at')
    .eq('job_id', jobId)
    .maybeSingle();

  if (fetchError) {
    logger.error('Lock fetch failed', { jobId, error: fetchError.message });
    throw new Error('Failed to check job lock');
  }

  if (existing) {
    const lockExpired = new Date(existing.expires_at) <= now;

    if (!lockExpired) {
      logger.warn('Lock already held', {
        jobId,
        operation: existing.operation,
        lockedBy:  existing.locked_by,
        expiresAt: existing.expires_at,
      });
      return false;
    }

    // Expired lock — overwrite it
    logger.info('Overwriting expired lock', { jobId, previousOperation: existing.operation });
    const { error: updateError } = await supabase
      .from('job_locks')
      .update({ locked_by: lockedBy, operation, locked_at: now.toISOString(), expires_at: expiresAt })
      .eq('job_id', jobId);

    if (updateError) {
      logger.error('Lock overwrite failed', { jobId, error: updateError.message });
      throw new Error('Failed to acquire job lock');
    }

    return true;
  }

  // No existing lock — insert new one
  const { error: insertError } = await supabase
    .from('job_locks')
    .insert({
      job_id:     jobId,
      locked_by:  lockedBy,
      operation,
      locked_at:  now.toISOString(),
      expires_at: expiresAt,
    });

  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation — another request got the lock first in a race
      logger.warn('Lock race — another process acquired first', { jobId });
      return false;
    }
    logger.error('Lock insert failed', { jobId, error: insertError.message });
    throw new Error('Failed to acquire job lock');
  }

  logger.info('Lock acquired', { jobId, operation, lockedBy });
  return true;
}

/**
 * Release a lock for a job.
 */
export async function releaseLock(jobId) {
  const { error } = await supabase
    .from('job_locks')
    .delete()
    .eq('job_id', jobId);

  if (error) {
    logger.warn('Lock release failed', { jobId, error: error.message });
  } else {
    logger.info('Lock released', { jobId });
  }
}

/**
 * Acquire lock, run fn, release lock even if fn throws.
 */
export async function withLock(jobId, operation, lockedBy, fn) {
  const acquired = await acquireLock(jobId, operation, lockedBy);

  if (!acquired) {
    const err = new Error(`Job ${jobId} is already being processed (operation: ${operation})`);
    err.code   = 'LOCK_CONFLICT';
    err.status = 409;
    throw err;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(jobId);
  }
}

/**
 * Express middleware factory.
 * Usage: router.post('/run-analysis', raceGuardMiddleware('pipeline'), handler)
 * Gets jobId from req.params.jobId
 * Gets lockedBy from req.worker.id (set by auth middleware)
 */
export function raceGuardMiddleware(operation) {
  return async function (req, res, next) {
    const jobId    = req.params.jobId;
    const lockedBy = req.worker?.id || 'unknown';

    if (!jobId) return next();

    try {
      const acquired = await acquireLock(jobId, operation, lockedBy);

      if (!acquired) {
        return res.status(409).json({
          error:                'Conflict',
          message:              `This job is currently being processed (${operation}). Please wait and try again.`,
          retry_after_seconds:  30,
        });
      }

      // Allow route to release early if needed
      req.releaseLock = () => releaseLock(jobId);

      // Auto-release when response finishes
      res.on('finish', () => {
        releaseLock(jobId).catch(() => {});
      });

      next();
    } catch (err) {
      logger.error('raceGuardMiddleware error', { jobId, operation, error: err.message });
      return res.status(500).json({ error: 'Failed to process lock. Please try again.' });
    }
  };
}