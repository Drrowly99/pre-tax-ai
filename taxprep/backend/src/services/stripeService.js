// src/services/stripeService.js
// Centralises all Stripe SDK interactions.
// Routes import from here — never instantiate Stripe directly in routes.
//
// Tiers → balance amounts (server-side, never trust client):
//   single → $277   full → $377   rush → $477

import Stripe from 'stripe';
import logger from '../utils/logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Deposit is always $20 regardless of tier
const DEPOSIT_AMOUNT_CENTS = 2000;

// Balance amounts per tier (cents)
const BALANCE_AMOUNTS = {
  single: 27700,
  full:   37700,
  rush:   47700,
};

// ── CUSTOMER ──────────────────────────────────────────────────────────────────

/**
 * Find existing Stripe customer by email or create a new one.
 *
 * @param {string} email
 * @param {string} name
 * @returns {Stripe.Customer}
 */
export async function createOrGetCustomer(email, name) {
  // Check for existing customer first
  const existing = await stripe.customers.list({ email, limit: 1 });

  if (existing.data.length > 0) {
    logger.info('Reusing existing Stripe customer', { customerId: existing.data[0].id });
    return existing.data[0];
  }

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { service: 'taxprep_pro' },
  });

  logger.info('Created new Stripe customer', { customerId: customer.id });
  return customer;
}

// ── DEPOSIT SESSION ───────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for the $20 deposit.
 *
 * @param {object} job        - Full job record from Supabase
 * @param {string} customerId - Stripe customer ID
 * @returns {Stripe.Checkout.Session}
 */
export async function createDepositSession(job, customerId) {
  const metadata = {
    job_id:       job.id,
    case_id:      job.case_id,
    payment_type: 'deposit',
    tier:         job.tier,
  };

  // Use price ID if configured, otherwise use price_data
  const lineItem = process.env.STRIPE_DEPOSIT_PRICE_ID
    ? {
        price:    process.env.STRIPE_DEPOSIT_PRICE_ID,
        quantity: 1,
      }
    : {
        price_data: {
          currency:     'usd',
          unit_amount:  DEPOSIT_AMOUNT_CENTS,
          product_data: {
            name:        'TaxPrep Pro — Processing Deposit',
            description: `Case ${job.case_id} — ${job.tier} tier`,
          },
        },
        quantity: 1,
      };

  const session = await stripe.checkout.sessions.create({
    customer:    customerId,
    mode:        'payment',
    line_items:  [lineItem],
    metadata,
    payment_intent_data: { metadata }, // webhook fallback
    success_url: `${process.env.FRONTEND_URL}/thankyou?session_id={CHECKOUT_SESSION_ID}&type=deposit`,
    cancel_url:  `${process.env.FRONTEND_URL}/checkout?case_id=${job.case_id}`,
  });

  logger.info('Deposit session created', { sessionId: session.id, caseId: job.case_id });
  return session;
}

// ── BALANCE SESSION ───────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for the balance payment.
 * Amount is always calculated server-side from job.tier.
 *
 * @param {object} job        - Full job record from Supabase
 * @param {string} customerId - Stripe customer ID
 * @returns {Stripe.Checkout.Session}
 */
export async function createBalanceSession(job, customerId) {
  const balanceCents = BALANCE_AMOUNTS[job.tier];

  if (!balanceCents) {
    throw new Error(`Invalid tier: ${job.tier}`);
  }

  const metadata = {
    job_id:       job.id,
    case_id:      job.case_id,
    payment_type: 'balance',
    tier:         job.tier,
  };

  const session = await stripe.checkout.sessions.create({
    customer:   customerId,
    mode:       'payment',
    line_items: [
      {
        price_data: {
          currency:     'usd',
          unit_amount:  balanceCents,
          product_data: {
            name:        'TaxPrep Pro — Full Report Unlock',
            description: `Case ${job.case_id} — ${job.tier} tier`,
          },
        },
        quantity: 1,
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${process.env.FRONTEND_URL}/review?case_id=${job.case_id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.FRONTEND_URL}/reveal?case_id=${job.case_id}`,
  });

  logger.info('Balance session created', {
    sessionId:    session.id,
    caseId:       job.case_id,
    balanceCents,
  });

  return session;
}

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

/**
 * Verify and construct a Stripe webhook event from raw request body.
 * Throws if signature is invalid.
 *
 * @param {Buffer} rawBody   - Raw request body (must use express.raw())
 * @param {string} signature - stripe-signature header value
 * @returns {Stripe.Event}
 */
export function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// ── SESSION RETRIEVAL ─────────────────────────────────────────────────────────

/**
 * Retrieve a Checkout session with expanded payment intent.
 *
 * @param {string} sessionId
 * @returns {Stripe.Checkout.Session}
 */
export async function retrieveSession(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
}

/**
 * Get the correct balance amount in dollars for a given tier.
 * Used by routes to validate and display pricing.
 */
export function getBalanceAmount(tier) {
  const cents = BALANCE_AMOUNTS[tier];
  return cents ? cents / 100 : null;
}

export { stripe };