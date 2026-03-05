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

import { validateBody } from '../middleware/validate.js';
import asyncHandler     from '../utils/asyncHandler.js';
import supabase         from '../utils/supabase.js';
import logger           from '../utils/logger.js';
import { generateExcel } from '../services/excelExport.js';

const router = Router();

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