// src/routes/jobs.js
// Worker-facing job routes.
//
// POST   /api/jobs                          — create job
// GET    /api/jobs                          — list worker's jobs
// GET    /api/jobs/:jobId                   — get job detail
// PATCH  /api/jobs/:jobId                   — update job (status, notes, etc.)
// POST   /api/jobs/:jobId/files             — upload PDF files
// POST   /api/jobs/:jobId/run-analysis      — trigger AI pipeline
// GET    /api/jobs/:jobId/status            — poll pipeline progress
// POST   /api/jobs/:jobId/publish           — publish results to client

import { Router }  from 'express';
import multer       from 'multer';
import path         from 'path';
import fs           from 'fs';
import { v4 as uuidv4 } from 'uuid';
import Joi          from 'joi';

import { requireWorkerAuth }           from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import asyncHandler                    from '../utils/asyncHandler.js';
import supabase                        from '../utils/supabase.js';
import logger                          from '../utils/logger.js';
import { runPipeline }                 from '../services/aiPipeline.js';
import { generate as generateCaseId }  from '../utils/caseId.js';

const router = Router();

// All job routes require worker auth
router.use(requireWorkerAuth);

// ── UPLOAD CONFIG ─────────────────────────────────────────────────────────────

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${uuidv4().slice(0, 8)}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50')) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' ||
      path.extname(file.originalname).toLowerCase() === '.pdf';
    if (!isPdf) return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  },
});

// ── TIER CONFIG ───────────────────────────────────────────────────────────────

const TIER_PRICING = {
  single: { total: 297, deposit: 20, balance: 277 },
  full:   { total: 397, deposit: 20, balance: 377 },
  rush:   { total: 497, deposit: 20, balance: 477 },
};

const SLA_HOURS = { single: 72, full: 72, rush: 24 };

// ── VALIDATION SCHEMAS ────────────────────────────────────────────────────────

const createJobSchema = Joi.object({
  client_name:        Joi.string().trim().min(1).max(200).required(),
  client_email:       Joi.string().email().required(),
  company_name:       Joi.string().trim().max(200).allow('', null),
  tier:               Joi.string().valid('single', 'full', 'rush').required(),
  bank_account_count: Joi.number().integer().min(1).max(20).required(),
  tax_year:           Joi.number().integer().min(2018).max(new Date().getFullYear()).required(),
  internal_notes:     Joi.string().max(2000).allow('', null),
});

const updateJobSchema = Joi.object({
  status:         Joi.string().valid(
    'pending','documents_received','ai_processing','ai_complete',
    'internal_review','needs_more_docs','published','balance_paid','complete','ai_failed'
  ),
  internal_notes: Joi.string().max(2000).allow('', null),
  assigned_to:    Joi.string().max(50).allow('', null),
}).min(1);

// ── POST /api/jobs — create job ───────────────────────────────────────────────

router.post('/', validateBody(createJobSchema), asyncHandler(async (req, res) => {
  const { client_name, client_email, company_name, tier, bank_account_count, tax_year, internal_notes } = req.body;

  const pricing     = TIER_PRICING[tier];
  const slaHours    = SLA_HOURS[tier];
  const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();
  const case_id     = await generateCaseId();

  const { data: job, error } = await supabase
    .from('jobs')
    .insert({
      id:                 uuidv4(),
      case_id,
      client_name,
      client_email,
      company_name:       company_name || null,
      tier,
      bank_account_count,
      tax_year,
      internal_notes:     internal_notes || null,
      status:             'pending',
      created_by:         req.worker.id,
      assigned_to:        req.worker.id,
      total_amount:       pricing.total,
      deposit_amount:     pricing.deposit,
      balance_amount:     pricing.balance,
      deposit_paid:       false,
      balance_paid:       false,
      sla_deadline:       slaDeadline,
      pipeline_progress:  0,
      pipeline_message:   null,
    })
    .select()
    .single();

  if (error) {
    logger.error('Job creation failed', { error: error.message, workerId: req.worker.id });
    return res.status(500).json({ error: 'Failed to create job' });
  }

  await auditLog(job.id, req.worker.id, 'job_created', { tier, case_id });

  logger.info('Job created', { jobId: job.id, caseId: case_id, workerId: req.worker.id });
  return res.status(201).json({ data: { job } });
}));

// ── GET /api/jobs — list worker's jobs ────────────────────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabase
    .from('jobs')
    .select('id, case_id, client_name, company_name, tier, status, created_at, sla_deadline, pipeline_progress, deposit_paid, balance_paid, income_total, deductions_total, estimated_tax_savings', { count: 'exact' })
    .eq('created_by', req.worker.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (status) query = query.eq('status', status);

  const { data: jobs, error, count } = await query;

  if (error) {
    logger.error('Jobs list failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch jobs' });
  }

  return res.json({
    data: {
      jobs,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: count },
    },
  });
}));

// ── GET /api/jobs/:jobId — get full job detail ────────────────────────────────

router.get('/:jobId', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  // Workers can only see their own jobs (admin route handles all-jobs view)
  if (job.created_by !== req.worker.id && job.assigned_to !== req.worker.id) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Fetch related data
  const [{ data: transactions }, { data: questions }, { data: files }] = await Promise.all([
    supabase.from('transactions').select('*').eq('job_id', jobId).order('date'),
    supabase.from('clarification_questions').select('*').eq('job_id', jobId),
    supabase.from('job_files').select('id, original_name, file_size, uploaded_at, status').eq('job_id', jobId),
  ]);

  return res.json({
    data: {
      job,
      transactions: transactions || [],
      questions:    questions    || [],
      files:        files        || [],
    },
  });
}));

// ── PATCH /api/jobs/:jobId — update job ───────────────────────────────────────

router.patch('/:jobId', validateBody(updateJobSchema), asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, created_by, assigned_to, status')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });
  if (job.created_by !== req.worker.id && job.assigned_to !== req.worker.id) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const updates = { ...req.body };

  // Auto-set published_at when publishing
  if (req.body.status === 'published' && job.status !== 'published') {
    updates.published_at = new Date().toISOString();
  }

  const { data: updated, error } = await supabase
    .from('jobs')
    .update(updates)
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    logger.error('Job update failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to update job' });
  }

  await auditLog(jobId, req.worker.id, 'job_updated', req.body);

  return res.json({ data: { job: updated } });
}));

// ── POST /api/jobs/:jobId/files — upload PDFs ─────────────────────────────────

router.post('/:jobId/files', upload.array('files', 20), asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, created_by, assigned_to')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });
  if (job.created_by !== req.worker.id && job.assigned_to !== req.worker.id) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Insert file records
  const fileRecords = req.files.map(f => ({
    id:            uuidv4(),
    job_id:        jobId,
    original_name: f.originalname,
    file_path:     f.path,
    file_size:     f.size,
    mime_type:     f.mimetype,
    status:        'uploaded',
    uploaded_at:   new Date().toISOString(),
  }));

  const { data: insertedFiles, error: insertErr } = await supabase
    .from('job_files')
    .insert(fileRecords)
    .select();

  if (insertErr) {
    logger.error('File record insert failed', { jobId, error: insertErr.message });
    return res.status(500).json({ error: 'Failed to save file records' });
  }

  // Update job status to documents_received
  await supabase
    .from('jobs')
    .update({ status: 'documents_received' })
    .eq('id', jobId)
    .eq('status', 'pending'); // only if still pending

  await auditLog(jobId, req.worker.id, 'files_uploaded', {
    fileCount: req.files.length,
    fileNames: req.files.map(f => f.originalname),
  });

  logger.info('Files uploaded', { jobId, fileCount: req.files.length });
  return res.status(201).json({ data: { files: insertedFiles } });
}));

// ── POST /api/jobs/:jobId/run-analysis — trigger AI pipeline ─────────────────

router.post('/:jobId/run-analysis', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, created_by, assigned_to, status')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });
  if (job.created_by !== req.worker.id && job.assigned_to !== req.worker.id) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'ai_processing') {
    return res.status(409).json({ error: 'AI analysis is already running for this job' });
  }

  // Check files exist
  const { data: files } = await supabase
    .from('job_files')
    .select('id, file_path, original_name')
    .eq('job_id', jobId)
    .neq('status', 'deleted');

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded yet. Upload PDFs before running analysis.' });
  }

  await auditLog(jobId, req.worker.id, 'pipeline_triggered', { fileCount: files.length });

  // Fire and forget — pipeline writes progress to DB
  const uploadedFiles = files.map(f => ({
    path:         f.file_path,
    originalname: f.original_name,
    filename:     path.basename(f.file_path),
  }));

  runPipeline(jobId, uploadedFiles).catch(err => {
    logger.error('Pipeline fire-and-forget error', { jobId, error: err.message });
  });

  logger.info('Pipeline triggered', { jobId, workerId: req.worker.id });
  return res.json({ data: { message: 'Analysis started', jobId } });
}));

// ── GET /api/jobs/:jobId/status — poll pipeline progress ─────────────────────

router.get('/:jobId/status', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, status, pipeline_progress, pipeline_message, pipeline_started_at, pipeline_completed_at, pipeline_error')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  // Any authenticated worker can poll status (useful for monitoring)
  return res.json({ data: { job } });
}));

// ── POST /api/jobs/:jobId/publish — publish results to client ─────────────────

router.post('/:jobId/publish', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, created_by, assigned_to, status')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });
  if (job.created_by !== req.worker.id && job.assigned_to !== req.worker.id) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const publishableStatuses = ['ai_complete', 'internal_review'];
  if (!publishableStatuses.includes(job.status)) {
    return res.status(400).json({
      error: `Job must be in ai_complete or internal_review status to publish. Current: ${job.status}`,
    });
  }

  const { data: updated, error } = await supabase
    .from('jobs')
    .update({
      status:       'published',
      published_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    logger.error('Publish failed', { jobId, error: error.message });
    return res.status(500).json({ error: 'Failed to publish job' });
  }

  await auditLog(jobId, req.worker.id, 'job_published', {});

  logger.info('Job published', { jobId, workerId: req.worker.id });
  return res.json({ data: { job: updated } });
}));

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function auditLog(jobId, workerId, action, details) {
  const { error } = await supabase
    .from('audit_log')
    .insert({ job_id: jobId, worker_id: workerId, action, details });
  if (error) logger.warn('Audit log failed', { jobId, action, error: error.message });
}

export default router;