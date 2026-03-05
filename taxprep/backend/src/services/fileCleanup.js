// src/services/fileCleanup.js
// Automatically deletes uploaded PDF files after FILE_DELETE_AFTER_HOURS (default 72h).
// Protects client data by not retaining documents longer than necessary.
//
// Called from server.js via setInterval — no external cron needed:
//   import { startCleanupSchedule } from './services/fileCleanup.js';
//   startCleanupSchedule();
//
// Export: { runCleanup, startCleanupSchedule }

import fs from 'fs';
import { promisify } from 'util';
import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

const unlink = promisify(fs.unlink);

const DELETE_AFTER_HOURS = parseInt(process.env.FILE_DELETE_AFTER_HOURS || '72', 10);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // run every hour

// Job statuses where files must NOT be deleted (pipeline still needs them)
const PROTECTED_STATUSES = new Set([
  'ai_processing',
  'documents_received',
]);

/**
 * Run one cleanup pass — finds and deletes expired files.
 * Safe to call manually (e.g. from admin route or tests).
 *
 * @returns {{ checked: number, deleted: number, errors: number }}
 */
export async function runCleanup() {
  const cutoff = new Date(Date.now() - DELETE_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  logger.info('File cleanup started', { cutoffHours: DELETE_AFTER_HOURS, cutoff });

  // Fetch expired files that haven't been deleted yet
  // Join with jobs to check status
  const { data: files, error } = await supabase
    .from('job_files')
    .select('id, job_id, file_path, original_name, jobs(status)')
    .lt('uploaded_at', cutoff)
    .neq('status', 'deleted')
    .not('file_path', 'is', null);

  if (error) {
    logger.error('File cleanup query failed', { error: error.message });
    return { checked: 0, deleted: 0, errors: 1 };
  }

  if (!files || files.length === 0) {
    logger.info('File cleanup: no expired files found');
    return { checked: 0, deleted: 0, errors: 0 };
  }

  let deleted = 0;
  let errors  = 0;

  for (const file of files) {
    try {
      // Skip if job is in a protected status
      const jobStatus = file.jobs?.status;
      if (PROTECTED_STATUSES.has(jobStatus)) {
        logger.info('File cleanup: skipping — job still processing', {
          fileId: file.id,
          jobStatus,
        });
        continue;
      }

      // Delete physical file
      if (file.file_path && fs.existsSync(file.file_path)) {
        await unlink(file.file_path);
        logger.info('File deleted from filesystem', { fileId: file.id });
      }

      // Update DB record: mark deleted, nullify path
      const { error: updateErr } = await supabase
        .from('job_files')
        .update({
          status:    'deleted',
          file_path: null,
        })
        .eq('id', file.id);

      if (updateErr) {
        logger.error('Failed to update file record after deletion', {
          fileId:  file.id,
          error:   updateErr.message,
        });
        errors++;
        continue;
      }

      // Audit log
      await logDeletion(file);

      deleted++;

    } catch (err) {
      // One failure must not stop other deletions
      logger.error('File cleanup error for individual file', {
        fileId: file.id,
        error:  err.message,
      });
      errors++;
    }
  }

  const summary = { checked: files.length, deleted, errors };
  logger.info('File cleanup complete', summary);
  return summary;
}

/**
 * Start the hourly cleanup schedule.
 * Call once from server.js after startup.
 */
export function startCleanupSchedule() {
  logger.info('File cleanup schedule started', {
    intervalHours: 1,
    deleteAfterHours: DELETE_AFTER_HOURS,
  });

  // Run once at startup (catches anything missed during downtime)
  runCleanup().catch(err => {
    logger.error('Initial cleanup run failed', { error: err.message });
  });

  setInterval(() => {
    runCleanup().catch(err => {
      logger.error('Scheduled cleanup run failed', { error: err.message });
    });
  }, CLEANUP_INTERVAL_MS);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function logDeletion(file) {
  const { error } = await supabase
    .from('audit_log')
    .insert({
      job_id:  file.job_id,
      action:  'file_auto_deleted',
      details: {
        file_id:       file.id,
        original_name: file.original_name,
        reason:        `Auto-deleted after ${DELETE_AFTER_HOURS} hours`,
      },
    });

  if (error) {
    logger.warn('Failed to write file deletion audit log', {
      fileId: file.id,
      error:  error.message,
    });
  }
}