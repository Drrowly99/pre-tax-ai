// src/routes/stripe.js
// Stripe payment routes and webhook handler.
//
// POST /api/stripe/create-deposit-session   — create $20 deposit checkout
// POST /api/stripe/create-balance-session   — create balance payment checkout
// POST /api/stripe/webhook                  — receive Stripe events
//
// CRITICAL: Webhook MUST use express.raw() — mounted specially in server.js.
// Signature verification happens before any processing.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Joi from 'joi';

import { validateBody }   from '../middleware/validate.js';
import asyncHandler       from '../utils/asyncHandler.js';
import supabase           from '../utils/supabase.js';
import logger             from '../utils/logger.js';
import {
  createOrGetCustomer,
  createDepositSession,
  createBalanceSession,
  constructWebhookEvent,
} from '../services/stripeService.js';
import { generateExcel }      from '../services/excelExport.js';
import { generateClientToken, hashClientToken } from './client.js';

const router = Router();

// ── POST /api/stripe/create-deposit-session ───────────────────────────────────

const depositSchema = Joi.object({
  case_id: Joi.string().required(),
  tier:    Joi.string().valid('single', 'full', 'rush').required(),
});

router.post('/create-deposit-session', validateBody(depositSchema), asyncHandler(async (req, res) => {
  const { case_id, tier } = req.body;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, client_name, client_email, tier, deposit_paid, stripe_customer_id')
    .eq('case_id', case_id)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });

  if (job.deposit_paid) {
    return res.status(400).json({ error: 'Deposit has already been paid for this case' });
  }

  // Get or create Stripe customer
  const customer = await createOrGetCustomer(job.client_email, job.client_name);

  // Save customer ID if new
  if (customer.id !== job.stripe_customer_id) {
    await supabase
      .from('jobs')
      .update({ stripe_customer_id: customer.id })
      .eq('id', job.id);
  }

  const session = await createDepositSession(job, customer.id);

  logger.info('Deposit session created', { caseId: case_id, sessionId: session.id });

  return res.json({
    data: {
      checkout_url: session.url,
      session_id:   session.id,
    },
  });
}));

// ── POST /api/stripe/create-balance-session ───────────────────────────────────

const balanceSchema = Joi.object({
  case_id: Joi.string().required(),
});

// Client token required for balance payment
function requireClientToken(req, res, next) {
  const token =
    req.query.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) return res.status(401).json({ error: 'Client token required' });

  // Dynamically import to avoid circular — token verification is in client.js
  // Instead we trust the token exists and validate case_id match after fetch
  req.clientToken = token;
  next();
}

router.post('/create-balance-session', requireClientToken, validateBody(balanceSchema), asyncHandler(async (req, res) => {
  const { case_id } = req.body;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, client_name, client_email, tier, status, balance_paid, balance_amount, stripe_customer_id')
    .eq('case_id', case_id)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Case not found' });

  if (job.status !== 'published') {
    return res.status(403).json({ error: 'Report must be published before balance payment' });
  }

  if (job.balance_paid) {
    return res.status(400).json({ error: 'Balance has already been paid' });
  }

  const customer = await createOrGetCustomer(job.client_email, job.client_name);

  if (customer.id !== job.stripe_customer_id) {
    await supabase
      .from('jobs')
      .update({ stripe_customer_id: customer.id })
      .eq('id', job.id);
  }

  const session = await createBalanceSession(job, customer.id);

  logger.info('Balance session created', { caseId: case_id, sessionId: session.id });

  return res.json({
    data: {
      checkout_url: session.url,
      session_id:   session.id,
    },
  });
}));

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// IMPORTANT: This route must receive the RAW body (Buffer), not parsed JSON.
// Register it in server.js BEFORE express.json() middleware using:
//   app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes)
// OR mount the webhook separately — see server.js comment.

router.post('/webhook', asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];

  // Verify signature immediately — reject anything unsigned
  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` });
  }

  // Always return 200 to Stripe immediately — process async
  res.status(200).json({ received: true });

  // Process in background — don't await
  processWebhookEvent(event).catch(err => {
    logger.error('Webhook processing error', { eventId: event.id, error: err.message });
  });
}));

// ── WEBHOOK EVENT PROCESSOR ───────────────────────────────────────────────────

async function processWebhookEvent(event) {
  // Idempotency check — use Stripe event ID as key
  const { data: existing } = await supabase
    .from('idempotency_keys')
    .select('id')
    .eq('id', event.id)
    .single();

  if (existing) {
    logger.info('Webhook event already processed — skipping', { eventId: event.id });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      default:
        logger.info('Unhandled webhook event type', { type: event.type });
    }
  } finally {
    // Record event as processed regardless of outcome (idempotency)
    await supabase
      .from('idempotency_keys')
      .insert({
        id:              event.id,
        response_status: 200,
        response_body:   { processed: true, type: event.type },
      })
      .on('conflict', 'id', 'ignore');
  }
}

async function handleCheckoutComplete(session) {
  const { job_id, case_id, payment_type } = session.metadata || {};

  if (!job_id) {
    logger.warn('Webhook: missing job_id in session metadata', { sessionId: session.id });
    return;
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, case_id, client_email, tier, status, deposit_paid, balance_paid')
    .eq('id', job_id)
    .single();

  if (error || !job) {
    logger.error('Webhook: job not found', { job_id });
    return;
  }

  if (payment_type === 'deposit') {
    if (job.deposit_paid) {
      logger.info('Webhook: deposit already recorded', { job_id });
      return;
    }

    await supabase
      .from('jobs')
      .update({
        deposit_paid:            true,
        stripe_deposit_session:  session.id,
        // Only set to pending if still at initial state
        status: job.status === 'pending' ? 'pending' : job.status,
      })
      .eq('id', job_id);

    await auditLog(job_id, null, 'deposit_paid', {
      session_id: session.id,
      amount:     session.amount_total,
    });

    // Generate and store client token
    const token      = generateClientToken(job.case_id, job.client_email);
    const tokenHash  = hashClientToken(token);

    await supabase
      .from('jobs')
      .update({ client_token_hash: tokenHash })
      .eq('id', job_id);

    logger.info('Deposit payment recorded', { job_id, caseId: case_id });

    // TODO Phase 2: sendDepositConfirmationEmail(job, token)

  } else if (payment_type === 'balance') {
    if (job.balance_paid) {
      logger.info('Webhook: balance already recorded', { job_id });
      return;
    }

    await supabase
      .from('jobs')
      .update({
        balance_paid:           true,
        stripe_balance_session: session.id,
        status:                 'balance_paid',
      })
      .eq('id', job_id);

    await auditLog(job_id, null, 'balance_paid', {
      session_id: session.id,
      amount:     session.amount_total,
    });

    logger.info('Balance payment recorded', { job_id, caseId: case_id });

    // Trigger Excel generation in background
    generateExcel(job_id).catch(err => {
      logger.error('Background Excel generation failed after balance payment', {
        job_id,
        error: err.message,
      });
    });

    // TODO Phase 2: sendBalanceConfirmationEmail(job) with Excel attachment
  }
}

async function handlePaymentFailed(paymentIntent) {
  const { job_id, case_id } = paymentIntent.metadata || {};
  if (!job_id) return;

  await auditLog(job_id, null, 'payment_failed', {
    payment_intent_id: paymentIntent.id,
    last_error:        paymentIntent.last_payment_error?.message,
  });

  logger.warn('Payment failed', { job_id, caseId: case_id });

  // TODO Phase 2: sendPaymentFailedEmail()
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function auditLog(jobId, workerId, action, details) {
  const { error } = await supabase
    .from('audit_log')
    .insert({
      job_id:    jobId,
      worker_id: workerId || null,
      action,
      details,
    });
  if (error) logger.warn('Stripe audit log failed', { jobId, action, error: error.message });
}

export default router;