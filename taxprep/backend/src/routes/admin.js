// src/routes/admin.js
// Internal admin routes — authenticated workers only.
// Extends jobs.js with management operations (assign, audit, bulk view, etc.)
//
// GET    /api/admin/dashboard
// GET    /api/admin/jobs/all
// PATCH  /api/admin/jobs/:jobId/assign
// POST   /api/admin/jobs/:jobId/request-docs
// GET    /api/admin/jobs/:jobId/audit
// POST   /api/admin/jobs/:jobId/audit
// DELETE /api/admin/jobs/:jobId/files/:fileId
// GET    /api/admin/workers

import { Router } from 'express';
import fs          from 'fs';
import Joi         from 'joi';
import { v4 as uuidv4 } from 'uuid';

import { requireWorkerAuth, getWorkers, isValidWorkerId } from '../middleware/auth.js';
import { validateBody, validateQuery }                     from '../middleware/validate.js';
import asyncHandler                                        from '../utils/asyncHandler.js';
import supabase                                            from '../utils/supabase.js';
import logger                                              from '../utils/logger.js';
import { runCleanup }                                      from '../services/fileCleanup.js';

const router = Router();
router.use(requireWorkerAuth);

// ── PROTECTED STATUSES — cannot delete files from these ──────────────────────
const FILE_DELETE_BLOCKED = new Set(['published', 'balance_paid', 'complete']);

// ── GET /api/admin/dashboard ─────────────────────────────────────────────────

router.get('/dashboard', asyncHandler(async (req, res) => {
  const now = new Date().toISOString();

  // Stats for the authenticated worker's jobs
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, status, sla_deadline, income_total, deductions_total, created_at, case_id, client_name, tier, pipeline_progress')
    .eq('created_by', req.worker.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Dashboard query failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }

  const byStatus = {};
  let overdueCount        = 0;
  let pipelineRunning     = 0;
  let totalIncome         = 0;
  let totalDeductions     = 0;

  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;

    if (job.status === 'ai_processing') pipelineRunning++;

    if (
      job.sla_deadline &&
      job.sla_deadline < now &&
      !['complete', 'balance_paid', 'published'].includes(job.status)
    ) {
      overdueCount++;
    }

    if (job.status === 'complete') {
      totalIncome      += parseFloat(job.income_total)      || 0;
      totalDeductions  += parseFloat(job.deductions_total)  || 0;
    }
  }

  return res.json({
    data: {
      stats: {
        total_jobs:               jobs.length,
        by_status:                byStatus,
        overdue_count:            overdueCount,
        pipeline_running_count:   pipelineRunning,
        total_income_processed:   parseFloat(totalIncome.toFixed(2)),
        total_deductions_found:   parseFloat(totalDeductions.toFixed(2)),
      },
      recent_jobs: jobs.slice(0, 5).map(j => ({
        id:               j.id,
        case_id:          j.case_id,
        client_name:      j.client_name,
        tier:             j.tier,
        status:           j.status,
        pipeline_progress: j.pipeline_progress,
        created_at:       j.created_at,
        sla_deadline:     j.sla_deadline,
      })),
    },
  });
}));

// ── GET /api/admin/jobs/all ──────────────────────────────────────────────────

const allJobsQuerySchema = Joi.object({
  page:   Joi.number().integer().min(1).default(1),
  limit:  Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid(
    'pending','documents_received','ai_processing','ai_complete',
    'internal_review','needs_more_docs','published','balance_paid','complete','ai_failed'
  ).optional(),
  tier: Joi.string().valid('single','full','rush').optional(),
});

router.get('/jobs/all', validateQuery(allJobsQuerySchema), asyncHandler(async (req, res) => {
  const { page, limit, status, tier } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('jobs')
    .select(
      'id, case_id, client_name, company_name, tier, status, created_by, assigned_to, created_at, sla_deadline, pipeline_progress, deposit_paid, balance_paid',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (tier)   query = query.eq('tier', tier);

  const { data: jobs, error, count } = await query;

  if (error) {
    logger.error('All jobs query failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch jobs' });
  }

  return res.json({
    data: {
      jobs,
      pagination: { page, limit, total: count },
    },
  });
}));

// ── PATCH /api/admin/jobs/:jobId/assign ───────────────────────────────────────

const assignSchema = Joi.object({
  assigned_to: Joi.string().required(),
});

router.patch('/jobs/:jobId/assign', validateBody(assignSchema), asyncHandler(async (req, res) => {
  const { jobId }      = req.params;
  const { assigned_to } = req.body;

  if (!isValidWorkerId(assigned_to)) {
    return res.status(400).json({ error: `Invalid worker id: ${assigned_to}` });
  }

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });

  const { data: updated, error } = await supabase
    .from('jobs')
    .update({ assigned_to })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    logger.error('Job reassignment failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to reassign job' });
  }

  await auditLog(jobId, req.worker.id, 'job_reassigned', { assigned_to });

  return res.json({ data: { job: updated } });
}));

// ── POST /api/admin/jobs/:jobId/request-docs ──────────────────────────────────

const requestDocsSchema = Joi.object({
  message: Joi.string().trim().min(1).max(2000).required(),
});

router.post('/jobs/:jobId/request-docs', validateBody(requestDocsSchema), asyncHandler(async (req, res) => {
  const { jobId }   = req.params;
  const { message } = req.body;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, internal_notes')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });

  const appendedNotes = job.internal_notes
    ? `${job.internal_notes}\n\n[${new Date().toLocaleDateString()}] ${message}`
    : `[${new Date().toLocaleDateString()}] ${message}`;

  const { data: updated, error } = await supabase
    .from('jobs')
    .update({
      status:         'needs_more_docs',
      internal_notes: appendedNotes,
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    logger.error('Request docs failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to update job' });
  }

  await auditLog(jobId, req.worker.id, 'docs_requested', { message });

  // TODO Phase 2: trigger email to client

  return res.json({ data: { job: updated } });
}));

// ── GET /api/admin/jobs/:jobId/audit ──────────────────────────────────────────

router.get('/jobs/:jobId/audit', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: logs, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Audit log fetch failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to fetch audit log' });
  }

  return res.json({ data: { audit_log: logs || [] } });
}));

// ── POST /api/admin/jobs/:jobId/audit ─────────────────────────────────────────

const manualAuditSchema = Joi.object({
  action:  Joi.string().trim().min(1).max(100).required(),
  details: Joi.object().default({}),
});

router.post('/jobs/:jobId/audit', validateBody(manualAuditSchema), asyncHandler(async (req, res) => {
  const { jobId }         = req.params;
  const { action, details } = req.body;

  const { data, error } = await supabase
    .from('audit_log')
    .insert({
      job_id:    jobId,
      worker_id: req.worker.id,
      action,
      details,
    })
    .select()
    .single();

  if (error) {
    logger.error('Manual audit log insert failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to write audit log' });
  }

  return res.status(201).json({ data: { entry: data } });
}));

// ── DELETE /api/admin/jobs/:jobId/files/:fileId ───────────────────────────────

router.delete('/jobs/:jobId/files/:fileId', asyncHandler(async (req, res) => {
  const { jobId, fileId } = req.params;

  // Fetch job to check status
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('id', jobId)
    .single();

  if (jobErr || !job) return res.status(404).json({ error: 'Job not found' });

  if (FILE_DELETE_BLOCKED.has(job.status)) {
    return res.status(400).json({
      error: `Cannot delete files from a job with status "${job.status}"`,
    });
  }

  // Fetch file record
  const { data: file, error: fileErr } = await supabase
    .from('job_files')
    .select('id, file_path, original_name, status')
    .eq('id', fileId)
    .eq('job_id', jobId)
    .single();

  if (fileErr || !file) return res.status(404).json({ error: 'File not found' });
  if (file.status === 'deleted') return res.status(404).json({ error: 'File already deleted' });

  // Delete from filesystem
  if (file.file_path && fs.existsSync(file.file_path)) {
    fs.unlinkSync(file.file_path);
  }

  // Mark deleted in DB
  const { error: updateErr } = await supabase
    .from('job_files')
    .update({ status: 'deleted', file_path: null })
    .eq('id', fileId);

  if (updateErr) {
    logger.error('File delete DB update failed', { fileId, error: updateErr.message });
    return res.status(500).json({ error: 'Failed to delete file record' });
  }

  await auditLog(jobId, req.worker.id, 'file_manually_deleted', {
    file_id:       fileId,
    original_name: file.original_name,
  });

  logger.info('File deleted by worker', { jobId, fileId, workerId: req.worker.id });
  return res.status(204).send();
}));

// ── GET /api/admin/workers ────────────────────────────────────────────────────

router.get('/workers', (req, res) => {
  return res.json({ data: { workers: getWorkers() } });
});

// ── GET /api/admin/cleanup (manual trigger) ───────────────────────────────────

router.post('/cleanup', asyncHandler(async (req, res) => {
  const result = await runCleanup();
  return res.json({ data: result });
}));

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function auditLog(jobId, workerId, action, details) {
  const { error } = await supabase
    .from('audit_log')
    .insert({ job_id: jobId, worker_id: workerId, action, details });
  if (error) logger.warn('Audit log failed', { jobId, action, error: error.message });
}

export default router;