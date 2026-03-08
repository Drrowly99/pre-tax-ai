// src/routes/client.js
// Client-facing routes — accessed by the paying customer (not workers).
// Client is identified via a signed token sent in status emails.
//
// Token format: base64url(JSON) + '.' + HMAC-SHA256 signature
// Token issued on deposit payment, valid for 30 days.
//
// GET  /api/client/status/:caseId      — public, no auth
// GET  /api/client/reveal/:caseId      — requires client token + published
// GET  /api/client/review/:caseId      — requires client token + balance_paid
// POST /api/client/review/:caseId/answer — answer clarification question
// GET  /api/client/download/:caseId    — download Excel, requires balance_paid

import { Router }  from 'express';
import crypto      from 'crypto';
import Joi         from 'joi';
import multer       from 'multer';
import path         from 'path';
import fs           from 'fs';
import { v4 as uuidv4 } from 'uuid';

import { validateBody } from '../middleware/validate.js';
import { requireClientAuth } from '../middleware/clientAuth.js';
import asyncHandler     from '../utils/asyncHandler.js';
import supabase         from '../utils/supabase.js';
import logger           from '../utils/logger.js';
import { generateExcel } from '../services/excelExport.js';
import { generate as generateCaseId } from '../utils/caseId.js';
import asyncHandler     from '../utils/asyncHandler.js';
import supabase         from '../utils/supabase.js';
import logger           from '../utils/logger.js';
import { generateExcel } from '../services/excelExport.js';

const router = Router();

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

// ── STATUS LABELS (never expose raw status to client) ─────────────────────────

const STATUS_LABELS = {
  pending:             { label: 'We received your request',              stage: 1 },
  documents_received:  { label: 'Your documents are being reviewed',     stage: 2 },
  ai_processing:       { label: 'Our team is reviewing your documents',  stage: 2 },
  ai_complete:         { label: 'Our team is reviewing your documents',  stage: 2 },
  internal_review:     { label: 'Our team is reviewing your documents',  stage: 2 },
  needs_more_docs:     { label: 'We need a few more documents from you', stage: 2 },
  published:           { label: 'Your results are ready to view',        stage: 3 },
  balance_paid:        { label: 'Payment received — preparing your report', stage: 4 },
  complete:            { label: 'Your report is ready to download',      stage: 5 },
  ai_failed:           { label: 'Our team is reviewing your documents',  stage: 2 },
};

// ── CLIENT TOKEN UTILS ────────────────────────────────────────────────────────

/**
 * Generate a signed client token for a job.
 * Stored as hash in jobs.client_token_hash for server-side validation.
 */
export function generateClientToken(caseId, email) {
  const payload = {
    case_id: caseId,
    email,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  const data      = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig       = hmac(data);
  return `${data}.${sig}`;
}

/**
 * Verify a client token. Returns decoded payload or null.
 */
function verifyClientToken(token) {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, sig] = parts;

  // Constant-time comparison
  const expected = hmac(data);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.exp || Date.now() > payload.exp) return null;

  return payload;
}

/**
 * Hash a token for storage (never store raw token).
 */
export function hashClientToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hmac(data) {
  return crypto
    .createHmac('sha256', process.env.CLIENT_TOKEN_SECRET || 'fallback-secret-change-me')
    .update(data)
    .digest('base64url');
}

/**
 * Express middleware — requires a valid client token in query or Authorization header.
 * Sets req.clientPayload = { case_id, email, exp } on success.
 */
function requireClientToken(req, res, next) {
  const token =
    req.query.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  const payload = verifyClientToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }

  req.clientPayload = payload;
  next();
}

// ── POST /api/client/jobs — Client Create Job ──────────────────────────────────

const createJobSchema = Joi.object({
  tier: Joi.string().valid('quick', 'business', 'full').required(),
  context: Joi.object().optional(),
});

const TIER_PRICING = {
  quick:    { total: 7.99, deposit: 7.99, balance: 0 },
  business: { total: 49.99, deposit: 25, balance: 24.99 },
  full:     { total: 89.99, deposit: 45, balance: 44.99 },
};

router.post('/jobs', requireClientAuth, validateBody(createJobSchema), asyncHandler(async (req, res) => {
  const { tier, context } = req.body;
  const pricing     = TIER_PRICING[tier];
  
  // Try to find if one already exists for this exact context?
  // Let's just create a new one every time they hit checkout.
  const case_id     = await generateCaseId();

  const { data: job, error } = await supabase
    .from('jobs')
    .insert({
      id:                 uuidv4(),
      case_id,
      client_name:        req.user.email, // using email as fallback
      client_email:       req.user.email,
      company_name:       null,
      tier,
      bank_account_count: 1, // default
      tax_year:           new Date().getFullYear() - 1,
      status:             'pending',
      created_by:         'client',
      assigned_to:        null,
      total_amount:       pricing.total,
      deposit_amount:     pricing.deposit,
      balance_amount:     pricing.balance,
      deposit_paid:       false,
      balance_paid:       pricing.balance === 0, // Quick extract has no balance
      pipeline_progress:  0,
      client_context:     context, // Store the wizard context
    })
    .select()
    .single();

  if (error) {
    logger.error('Client Job creation failed', { error: error.message, client: req.user.email });
    return res.status(500).json({ error: 'Failed to create job' });
  }

  logger.info('Client Job created', { jobId: job.id, caseId: case_id, client: req.user.email });
  return res.status(201).json({ data: { job } });
}));

// ── POST /api/client/jobs/:id/files — Client Upload Files ─────────────────────

router.post('/jobs/:jobId/files', requireClientAuth, upload.array('files', 20), asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error: fetchErr } = await supabase
    .from('jobs')
    .select('id, client_email')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) return res.status(404).json({ error: 'Job not found' });
  if (job.client_email !== req.user.email) return res.status(403).json({ error: 'Unauthorized' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const fileRecords = req.files.map(f => ({
    id:            uuidv4(),
    job_id:        jobId,
    filename:      f.filename,
    original_name: f.originalname,
    file_path:     f.path,
    file_size:     f.size,
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

  await supabase
    .from('jobs')
    .update({ status: 'documents_received' })
    .eq('id', jobId)
    .eq('status', 'pending');

  logger.info('Client Files uploaded', { jobId, fileCount: req.files.length });
  return res.status(201).json({ data: { files: insertedFiles } });
}));

// ── GET /api/client/status/:caseId — public ───────────────────────────────────

router.get('/status/:caseId', asyncHandler(async (req, res) => {
  const { caseId } = req.params;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, status, sla_deadline, created_at, deposit_paid, balance_paid, published_at')
    .eq('case_id', caseId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });

  const statusInfo = STATUS_LABELS[job.status] || { label: 'In progress', stage: 2 };

  // Estimate completion: SLA deadline or 48h from creation
  const estimatedCompletion = job.sla_deadline ||
    new Date(new Date(job.created_at).getTime() + 48 * 60 * 60 * 1000).toISOString();

  return res.json({
    data: {
      case_id:               job.case_id,
      status:                job.status,
      status_label:          statusInfo.label,
      stage_number:          statusInfo.stage,
      sla_deadline:          job.sla_deadline,
      estimated_completion:  estimatedCompletion,
      deposit_paid:          job.deposit_paid,
      balance_paid:          job.balance_paid,
      submitted_at:          job.created_at,
      // NEVER: transactions, AI data, worker info, internal_notes, financial data
    },
  });
}));

// ── GET /api/client/reveal/:caseId — deduction reveal (pre-payment) ───────────

router.get('/reveal/:caseId', requireClientToken, asyncHandler(async (req, res) => {
  const { caseId } = req.params;

  const { data: job, error } = await supabase
    .from('jobs')
    .select([
      'id', 'case_id', 'status', 'tier', 'balance_amount',
      'company_name', 'income_total', 'income_1099_total',
      'deductions_total', 'estimated_tax_savings',
      'transactions_count', 'flagged_count', 'balance_paid',
    ].join(', '))
    .eq('case_id', caseId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });

  // Verify token is for this case
  if (req.clientPayload.case_id !== caseId) {
    return res.status(403).json({ error: 'Token does not match this case' });
  }

  if (job.status !== 'published') {
    return res.status(403).json({ error: 'Results are not yet available for this case' });
  }

  return res.json({
    data: {
      // Financial summary only — NEVER individual transactions here
      income_total:          parseFloat(job.income_total)          || 0,
      deductions_total:      parseFloat(job.deductions_total)      || 0,
      estimated_tax_savings: parseFloat(job.estimated_tax_savings) || 0,
      transactions_count:    job.transactions_count                || 0,
      flagged_count:         job.flagged_count                     || 0,
      balance_amount:        job.balance_amount,
      company_name:          job.company_name || null,
    },
  });
}));

// ── GET /api/client/review/:caseId — full transaction list (post-payment) ─────

router.get('/review/:caseId', requireClientToken, asyncHandler(async (req, res) => {
  const { caseId } = req.params;

  if (req.clientPayload.case_id !== caseId) {
    return res.status(403).json({ error: 'Token does not match this case' });
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, status, balance_paid, gap_report, subcontractor_warnings, financial_summary')
    .eq('case_id', caseId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });

  if (!job.balance_paid) {
    return res.status(403).json({ error: 'Balance payment required to access full report' });
  }

  const [{ data: transactions }, { data: questions }] = await Promise.all([
    supabase
      .from('transactions')
      .select('*')
      .eq('job_id', job.id)
      .order('date', { ascending: true }),
    supabase
      .from('clarification_questions')
      .select('*')
      .eq('job_id', job.id),
  ]);

  return res.json({
    data: {
      transactions:           transactions || [],
      clarification_questions: questions   || [],
      gap_report:             job.gap_report,
      subcontractor_warnings: job.subcontractor_warnings,
      financial_summary:      job.financial_summary,
    },
  });
}));

// ── POST /api/client/review/:caseId/answer ────────────────────────────────────

const answerSchema = Joi.object({
  question_id: Joi.string().required(),
  answer:      Joi.string().trim().min(1).max(2000).required(),
});

router.post('/review/:caseId/answer', requireClientToken, validateBody(answerSchema), asyncHandler(async (req, res) => {
  const { caseId }            = req.params;
  const { question_id, answer } = req.body;

  if (req.clientPayload.case_id !== caseId) {
    return res.status(403).json({ error: 'Token does not match this case' });
  }

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('id, balance_paid')
    .eq('case_id', caseId)
    .single();

  if (jobErr || !job) return res.status(404).json({ error: 'Case not found' });
  if (!job.balance_paid) return res.status(403).json({ error: 'Balance payment required' });

  // Fetch the question
  const { data: question, error: qErr } = await supabase
    .from('clarification_questions')
    .select('*')
    .eq('id', question_id)
    .eq('job_id', job.id)
    .single();

  if (qErr || !question) return res.status(404).json({ error: 'Question not found' });

  // Idempotent: same answer = no-op
  if (question.resolved && question.answer === answer) {
    return res.json({ data: { question } });
  }

  // Update question
  const { data: updatedQ, error: updateErr } = await supabase
    .from('clarification_questions')
    .update({ answer, resolved: true })
    .eq('id', question_id)
    .select()
    .single();

  if (updateErr) {
    logger.error('Answer save failed', { questionId: question_id, error: updateErr.message });
    return res.status(500).json({ error: 'Failed to save answer' });
  }

  // Update linked transactions with client_response
  if (question.transaction_ids?.length > 0) {
    await supabase
      .from('transactions')
      .update({ client_response: answer })
      .in('id', question.transaction_ids);
  }

  return res.json({ data: { question: updatedQ } });
}));

// ── GET /api/client/download/:caseId — stream Excel file ─────────────────────

router.get('/download/:caseId', requireClientToken, asyncHandler(async (req, res) => {
  const { caseId } = req.params;

  if (req.clientPayload.case_id !== caseId) {
    return res.status(403).json({ error: 'Token does not match this case' });
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, balance_paid, tax_year, status')
    .eq('case_id', caseId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });
  if (!job.balance_paid) return res.status(403).json({ error: 'Balance payment required to download report' });

  logger.info('Excel download requested', { caseId, jobId: job.id });

  const buffer   = await generateExcel(job.id);
  const taxYear  = job.tax_year || new Date().getFullYear() - 1;
  const filename = `TaxPrep_${caseId}_${taxYear}.xlsx`;

  // Update status to complete on first download
  if (job.status === 'balance_paid') {
    await supabase
      .from('jobs')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', job.id);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.byteLength);
  return res.send(buffer);
}));

export default router;