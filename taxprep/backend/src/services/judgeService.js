// src/services/judgeService.js
// The Judge reconciles outputs from all 4 AI extractions into one
// authoritative master transaction list per statement.
//
// Called from aiPipeline.js after Claude text, Claude vision,
// Gemini text, and Gemini vision have all run for a single PDF.
//
// Strategy:
//   1. Flatten all 4 transaction lists
//   2. Group transactions that appear to be the same event
//      (fuzzy match on date + amount + description prefix)
//   3. For each group, pick the best representative and calculate
//      a consensus score (how many models agreed)
//   4. Flag transactions only one model saw (low confidence)
//   5. Verify math: opening + credits - debits ≈ closing
//   6. Return master list + statement metadata

import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';
import { buildSystemPrompt, parseExtractionResponse, TAX_CATEGORIES } from './extractionPrompt.js';

const client      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL       = 'claude-3-5-sonnet-20241022';
const MAX_TOKENS  = 8192;

// Thresholds
const AMOUNT_TOLERANCE     = 0.02;  // $0.02 — rounding differences between models
const DATE_FUZZ_DAYS       = 1;     // ±1 day — some models read posting vs transaction date
const DESCRIPTION_MIN_MATCH = 6;    // chars — min shared prefix to consider same merchant

/**
 * Reconcile 4 extraction results into one master transaction list.
 *
 * @param {Array} results - [claudeTextResult, claudeVisionResult, geminiTextResult, geminiVisionResult]
 * @param {string} filename
 * @returns {object} judgedResult
 */
export async function runJudge(results, filename) {
  logger.info('Judge started', { filename, modelCount: results.length });

  // ── Filter out failed extractions ─────────────────────────────────────────
  const valid = results.filter(r => r && Array.isArray(r.transactions) && r.transactions.length > 0);

  if (valid.length === 0) {
    logger.warn('Judge: no valid extractions to reconcile', { filename });
    return emptyJudgeResult('All 4 extractions returned empty results');
  }

  // ── Pick best metadata from the extraction with most transactions ─────────
  const metaSource = valid.reduce((best, r) =>
    r.transactions.length > best.transactions.length ? r : best
  , valid[0]);

  // ── Group matching transactions across models ─────────────────────────────
  const groups = groupTransactions(valid.flatMap(r => r.transactions));

  // ── Resolve each group to one canonical transaction ───────────────────────
  const resolved = groups.map(group => resolveGroup(group, valid.length));

  // ── For ambiguous transactions: use Claude to make a final call ───────────
  const needsAiReview = resolved.filter(t =>
    t.consensus_score === 1 || t.confidence === 'LOW' || t.category === 'unknown'
  );

  let aiReviewed = [];
  if (needsAiReview.length > 0 && needsAiReview.length <= 50) {
    aiReviewed = await aiTiebreak(needsAiReview, filename);
  } else {
    aiReviewed = needsAiReview;
  }

  // Merge ai-reviewed back in
  const aiReviewedIds = new Set(aiReviewed.map(t => t._groupId));
  const finalTransactions = [
    ...resolved.filter(t => !aiReviewedIds.has(t._groupId)),
    ...aiReviewed,
  ].map(({ _groupId, ...t }) => t); // strip internal _groupId field

  // ── Math verification ─────────────────────────────────────────────────────
  const mathCheck = verifyMath(
    finalTransactions,
    metaSource.opening_balance,
    metaSource.closing_balance
  );

  logger.info('Judge complete', {
    filename,
    totalTransactions: finalTransactions.length,
    consensusFlags:    finalTransactions.filter(t => t.consensus_score === 1).length,
    mathClosed:        mathCheck.closed,
  });

  return {
    account_number_last4:    metaSource.account_number_last4   || null,
    statement_period_start:  metaSource.statement_period_start || null,
    statement_period_end:    metaSource.statement_period_end   || null,
    opening_balance:         metaSource.opening_balance        || null,
    closing_balance:         metaSource.closing_balance        || null,
    math_closed:             mathCheck.closed,
    math_discrepancy:        mathCheck.discrepancy,
    missing_transaction_flag: !mathCheck.closed && Math.abs(mathCheck.discrepancy) > 1,
    transactions:            finalTransactions,
    models_used:             valid.length,
    extraction_notes:        valid.length < 4
      ? `Only ${valid.length}/4 models returned results` : null,
  };
}

// ── GROUPING ──────────────────────────────────────────────────────────────────

/**
 * Group transactions that represent the same real-world event.
 * Uses date + amount proximity + description similarity.
 */
function groupTransactions(transactions) {
  const groups  = [];
  const assigned = new Set();

  for (let i = 0; i < transactions.length; i++) {
    if (assigned.has(i)) continue;

    const group = [transactions[i]];
    assigned.add(i);

    for (let j = i + 1; j < transactions.length; j++) {
      if (assigned.has(j)) continue;
      if (isSameTransaction(transactions[i], transactions[j])) {
        group.push(transactions[j]);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

function isSameTransaction(a, b) {
  // Must be same type (debit/credit)
  if (a.type !== b.type) return false;

  // Amount must match within tolerance
  const aAmount = parseFloat(a.amount) || 0;
  const bAmount = parseFloat(b.amount) || 0;
  if (Math.abs(aAmount - bAmount) > AMOUNT_TOLERANCE) return false;

  // Date must be within fuzz window
  const aDate = parseDate(a.date);
  const bDate = parseDate(b.date);
  if (aDate && bDate) {
    const diffDays = Math.abs((aDate - bDate) / (1000 * 60 * 60 * 24));
    if (diffDays > DATE_FUZZ_DAYS) return false;
  }

  // Description must share a meaningful prefix
  const aDesc = (a.description || '').toLowerCase().slice(0, 20);
  const bDesc = (b.description || '').toLowerCase().slice(0, 20);
  const shared = sharedPrefixLength(aDesc, bDesc);
  if (shared < DESCRIPTION_MIN_MATCH) return false;

  return true;
}

// ── RESOLUTION ────────────────────────────────────────────────────────────────

/**
 * From a group of matching transactions, produce one canonical record.
 * Prefers higher-confidence values; tracks how many models agreed.
 */
function resolveGroup(group, totalModels) {
  // Sort: HIGH confidence first, then by description length (longer = more detail)
  const sorted = [...group].sort((a, b) => {
    const confScore = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const scoreDiff = (confScore[b.confidence] || 1) - (confScore[a.confidence] || 1);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.description?.length || 0) - (a.description?.length || 0);
  });

  const best = sorted[0];

  // Majority-vote on category
  const categoryVotes = {};
  for (const t of group) {
    if (t.category) categoryVotes[t.category] = (categoryVotes[t.category] || 0) + 1;
  }
  const winningCategory = Object.entries(categoryVotes)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

  // Majority-vote on is_business
  const businessVotes = group.filter(t => t.is_business === true).length;
  const notBusinessVotes = group.filter(t => t.is_business === false).length;
  const isBusinessResolved =
    businessVotes > notBusinessVotes ? true :
    notBusinessVotes > businessVotes ? false : null;

  const consensusScore = group.length; // how many models saw this transaction

  return {
    _groupId:           Math.random().toString(36).slice(2), // internal only
    date:               best.date,
    description:        best.description,
    amount:             best.amount,
    type:               best.type,
    category:           winningCategory,
    is_business:        isBusinessResolved,
    confidence:         best.confidence,
    consensus_score:    consensusScore,       // 1 = only one model saw it (suspicious)
    needs_clarification: consensusScore === 1 || winningCategory === 'unknown' || isBusinessResolved === null,
    notes:              best.notes,
  };
}

// ── AI TIEBREAK ───────────────────────────────────────────────────────────────

/**
 * Ask Claude to review low-confidence / single-model transactions
 * and make a final determination on category and is_business.
 */
async function aiTiebreak(transactions, filename) {
  const prompt = `You are reviewing a list of bank transactions that had low confidence 
or were only detected by one AI model. For each transaction, determine:
1. The correct tax category (from the list in your system prompt)
2. Whether it is a business expense (true/false/null if truly unknown)
3. Whether it needs client clarification

Respond with a JSON array matching the input structure exactly.
Input transactions:
${JSON.stringify(transactions.map(({ _groupId, ...t }) => ({ ...t, _groupId })), null, 2)}

Return the same array with updated category, is_business, and needs_clarification fields.
JSON only, no markdown.`;

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     buildSystemPrompt(),
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = response.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const cleaned = raw?.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return transactions;

    logger.info('AI tiebreak complete', { filename, reviewed: parsed.length });
    return parsed;
  } catch (err) {
    logger.warn('AI tiebreak failed — using original values', {
      filename,
      error: err.message,
    });
    return transactions;
  }
}

// ── MATH VERIFICATION ─────────────────────────────────────────────────────────

function verifyMath(transactions, openingBalance, closingBalance) {
  if (openingBalance == null || closingBalance == null) {
    return { closed: null, discrepancy: null };
  }

  const totalCredits = transactions
    .filter(t => t.type === 'credit')
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const totalDebits = transactions
    .filter(t => t.type === 'debit')
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const calculated  = parseFloat(openingBalance) + totalCredits - totalDebits;
  const discrepancy = parseFloat((calculated - parseFloat(closingBalance)).toFixed(2));
  const closed      = Math.abs(discrepancy) < 1.00; // within $1 tolerance

  return { closed, discrepancy };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d) ? null : d;
}

function sharedPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function emptyJudgeResult(note) {
  return {
    account_number_last4:     null,
    statement_period_start:   null,
    statement_period_end:     null,
    opening_balance:          null,
    closing_balance:          null,
    math_closed:              null,
    math_discrepancy:         null,
    missing_transaction_flag: false,
    transactions:             [],
    models_used:              0,
    extraction_notes:         note,
  };
}