import logger from '../utils/logger.js';
import { supabase } from '../utils/supabase.js';

/**
 * Race Guard / Distributed Lock Middleware
 * Prevents race conditions on critical operations
 *
 * CREATE TABLE job_locks (
 *   job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 *   locked_by TEXT NOT NULL,
 *   locked_at TIMESTAMPTZ DEFAULT NOW(),
 *   operation TEXT NOT NULL,
 *   expires_at TIMESTAMPTZ NOT NULL
 * );
 */

const LOCK_TTL_MINUTES = 10;

/**
 * Acquire a lock on a job
 * Returns true if lock acquired, false if already locked
 */
export async function acquireLock(jobId, operation, lockedBy) {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MINUTES * 60 * 1000);

    // Check if lock exists and is not expired
    const { data: existingLock, error: fetchError } = await supabase
      .from('job_locks')
      .select('expires_at, locked_by')
      .eq('job_id', jobId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      logger.error(`Lock fetch error for job ${jobId}: ${fetchError.message}`);
      throw fetchError;
    }

    if (existingLock) {
      const expiresAtTime = new Date(existingLock.expires_at);
      if (expiresAtTime > now) {
        // Lock is still valid
        logger.warn(`Lock already held on job ${jobId} by ${existingLock.locked_by}`);
        return false;
      }
      // Lock is stale — will be overwritten below
    }

    // Acquire lock via upsert
    const { error: upsertError } = await supabase
      .from('job_locks')
      .upsert({
        job_id: jobId,
        locked_by: lockedBy,
        operation: operation,
        locked_at: now.toISOString(),
        expires_at: expiresAt.toISOString()
      }, {
        onConflict: 'job_id'
      });

    if (upsertError) {
      logger.error(`Failed to acquire lock on job ${jobId}: ${upsertError.message}`);
      throw upsertError;
    }

    logger.info(`Lock acquired on job ${jobId} for operation ${operation}`);
    return true;
  } catch (err) {
    logger.error(`acquireLock error: ${err.message}`);
    throw err;
  }
}

/**
 * Release a lock on a job
 */
export async function releaseLock(jobId) {
  try {
    const { error } = await supabase
      .from('job_locks')
      .delete()
      .eq('job_id', jobId);

    if (error) {
      logger.error(`Failed to release lock on job ${jobId}: ${error.message}`);
      throw error;
    }

    logger.info(`Lock released on job ${jobId}`);
  } catch (err) {
    logger.error(`releaseLock error: ${err.message}`);
    throw err;
  }
}

/**
 * Acquire lock, run function, release lock (even on error)
 */
export async function withLock(jobId, operation, lockedBy, fn) {
  const locked = await acquireLock(jobId, operation, lockedBy);

  if (!locked) {
    const err = new Error(`Job ${jobId} is locked for operation ${operation}`);
    err.status = 409;
    throw err;
  }

  try {
    const result = await fn();
    return result;
  } finally {
    // Always release lock
    try {
      await releaseLock(jobId);
    } catch (err) {
      logger.error(`Error releasing lock during cleanup: ${err.message}`);
    }
  }
}

/**
 * Express middleware wrapper
 * Checks for race conditions on protected operations
 */
export function raceGuardMiddleware(req, res, next) {
  // This middleware typically doesn't block immediately
  // Instead, specific route handlers call withLock()
  // But we can add global race condition detection here if needed

  next();
}

export default { acquireLock, releaseLock, withLock, raceGuardMiddleware };
