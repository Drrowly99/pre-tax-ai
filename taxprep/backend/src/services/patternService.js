// src/services/patternService.js
// Takes the merged + deduped transaction list from aiPipeline.js and:
//   1. Groups transactions by merchant into recurring patterns
//   2. Detects subcontractor payments that may require 1099-NEC
//   3. Generates batched clarification questions for ambiguous transactions
//   4. Calculates the financial summary (income, deductions, savings estimate)
//
// This is pure JS — no AI calls. Fast and deterministic.
//
// Export: analysePatterns(transactions) → { transactions, clarification_questions, summary, subcontractor_warnings }

import logger from '../utils/logger.js';

// Tax savings estimate rate — clearly labelled as estimate in the report
const ESTIMATED_TAX_RATE = 0.28;

// Anyone paid this much or more may need a 1099-NEC
const SUBCONTRACTOR_1099_THRESHOLD = 600;

// Categories that count as deductible business expenses for Schedule C
const DEDUCTIBLE_CATEGORIES = new Set([
  'materials_supplies',
  'tools_equipment',
  'fuel_mileage',
  'vehicle_maintenance',
  'subcontractor_labor',
  'dump_fees_disposal',
  'permits_fees',
  'insurance',
  'phone_internet',
  'advertising_marketing',
  'office_supplies',
  'professional_services',
  'rent_storage',
  'utilities',
  'meals_entertainment',   // note: only 50% deductible, but we track gross
  'travel_lodging',
  'banking_fees',
  'software_subscriptions',
]);

// Categories that generate clarification questions automatically
const CLARIFICATION_CATEGORIES = new Set([
  'unknown',
  'meals_entertainment',   // need to confirm business purpose
  'travel_lodging',        // need to confirm business trip
]);

/**
 * Main entry point — analyse the full merged transaction list.
 *
 * @param {Array} transactions - Merged, deduped, judge-resolved transactions
 * @returns {{ transactions, clarification_questions, summary, subcontractor_warnings }}
 */
export function analysePatterns(transactions) {
  logger.info('Pattern analysis started', { transactionCount: transactions.length });

  if (!transactions || transactions.length === 0) {
    return {
      transactions:            [],
      clarification_questions: [],
      summary:                 buildEmptySummary(),
      subcontractor_warnings:  [],
    };
  }

  // ── Step 1: Group by merchant → detect recurring patterns ─────────────────
  const merchantGroups = groupByMerchant(transactions);
  const enriched       = enrichWithPatterns(transactions, merchantGroups);

  // ── Step 2: Detect subcontractor payments ────────────────────────────────
  const subcontractorWarnings = detectSubcontractors(enriched);

  // ── Step 3: Generate clarification questions ──────────────────────────────
  const clarificationQuestions = generateClarificationQuestions(enriched);

  // ── Step 4: Tag transactions that have questions ──────────────────────────
  const questionTxIds = new Set(
    clarificationQuestions.flatMap(q => q.transaction_ids || [])
  );

  const finalTransactions = enriched.map(t => ({
    ...t,
    needs_clarification: t.needs_clarification || questionTxIds.has(t.id),
  }));

  // ── Step 5: Financial summary ─────────────────────────────────────────────
  const summary = calculateSummary(finalTransactions, clarificationQuestions);

  logger.info('Pattern analysis complete', {
    merchants:     Object.keys(merchantGroups).length,
    questions:     clarificationQuestions.length,
    subcontractors: subcontractorWarnings.length,
    income:        summary.total_income,
    deductions:    summary.total_deductions,
    savings:       summary.estimated_tax_savings,
  });

  return {
    transactions:            finalTransactions,
    clarification_questions: clarificationQuestions,
    summary,
    subcontractor_warnings:  subcontractorWarnings,
  };
}

// ── MERCHANT GROUPING ─────────────────────────────────────────────────────────

function groupByMerchant(transactions) {
  const groups = {};

  for (const t of transactions) {
    const key = normaliseMerchant(t.description);
    if (!groups[key]) {
      groups[key] = {
        normalisedName: key,
        transactions:   [],
        totalAmount:    0,
        category:       t.category,
        is_business:    t.is_business,
      };
    }
    groups[key].transactions.push(t);
    groups[key].totalAmount += parseFloat(t.amount) || 0;
  }

  return groups;
}

/**
 * Normalise a merchant name for grouping.
 * Strips trailing numbers, dates, and noise suffixes.
 */
function normaliseMerchant(description) {
  if (!description) return 'UNKNOWN';

  return description
    .toUpperCase()
    .replace(/\s+#?\d{4,}/g, '')          // strip trailing reference numbers
    .replace(/\s+\d{2}\/\d{2}/g, '')      // strip date suffixes like 01/15
    .replace(/\s+(LLC|INC|CORP|CO)\.?$/g, '') // strip legal suffixes
    .replace(/[^A-Z0-9\s]/g, '')           // keep alphanumeric only
    .trim()
    .slice(0, 40);                          // cap length
}

/**
 * Add pattern metadata to each transaction based on merchant groups.
 */
function enrichWithPatterns(transactions, merchantGroups) {
  return transactions.map(t => {
    const key   = normaliseMerchant(t.description);
    const group = merchantGroups[key];

    const occurrences = group?.transactions.length || 1;
    const isRecurring = occurrences >= 2;

    return {
      ...t,
      merchant_normalised: key,
      merchant_occurrences: occurrences,
      is_recurring:        isRecurring,
      // If recurring and is_business was null, inherit from majority in group
      is_business: t.is_business !== null
        ? t.is_business
        : inferBusinessFromGroup(group),
    };
  });
}

function inferBusinessFromGroup(group) {
  if (!group) return null;
  const biz    = group.transactions.filter(t => t.is_business === true).length;
  const nonBiz = group.transactions.filter(t => t.is_business === false).length;
  if (biz > nonBiz) return true;
  if (nonBiz > biz) return false;
  return null;
}

// ── SUBCONTRACTOR DETECTION ───────────────────────────────────────────────────

function detectSubcontractors(transactions) {
  // Group subcontractor_labor payments by recipient
  const subGroups = {};

  for (const t of transactions) {
    if (t.category !== 'subcontractor_labor') continue;
    if (t.type !== 'debit') continue;

    const key = normaliseMerchant(t.description);
    if (!subGroups[key]) {
      subGroups[key] = { name: t.description, totalPaid: 0, paymentCount: 0 };
    }
    subGroups[key].totalPaid    += parseFloat(t.amount) || 0;
    subGroups[key].paymentCount += 1;
  }

  return Object.values(subGroups)
    .map(s => ({
      ...s,
      totalPaid:     parseFloat(s.totalPaid.toFixed(2)),
      requires_1099: s.totalPaid >= SUBCONTRACTOR_1099_THRESHOLD,
    }))
    .sort((a, b) => b.totalPaid - a.totalPaid);
}

// ── CLARIFICATION QUESTIONS ───────────────────────────────────────────────────

function generateClarificationQuestions(transactions) {
  const questions = [];

  // Group unknown/ambiguous transactions by normalised merchant
  // so we ask ONE question per merchant, not one per transaction
  const merchantQuestionMap = new Map();

  for (const t of transactions) {
    const needsQuestion =
      t.category === 'unknown' ||
      t.is_business === null ||
      t.needs_clarification ||
      CLARIFICATION_CATEGORIES.has(t.category);

    if (!needsQuestion) continue;

    const key = normaliseMerchant(t.description);

    if (!merchantQuestionMap.has(key)) {
      merchantQuestionMap.set(key, {
        merchant:        key,
        display_name:    t.description,
        category:        t.category,
        transaction_ids: [],
        total_amount:    0,
        occurrences:     0,
      });
    }

    const entry = merchantQuestionMap.get(key);
    entry.transaction_ids.push(t.id);
    entry.total_amount += parseFloat(t.amount) || 0;
    entry.occurrences  += 1;
  }

  for (const [, entry] of merchantQuestionMap) {
    const question = buildQuestion(entry);
    if (question) questions.push(question);
  }

  return questions;
}

function buildQuestion(entry) {
  const { merchant, display_name, category, transaction_ids, total_amount, occurrences } = entry;

  const amountStr    = `$${total_amount.toFixed(2)}`;
  const occurrenceStr = occurrences > 1 ? `${occurrences} payments totalling ${amountStr}` : amountStr;

  let questionText;
  let questionType = 'business_purpose';

  if (category === 'unknown') {
    questionText = `We found ${occurrenceStr} paid to "${display_name}". ` +
      `What was the business purpose of these payments? ` +
      `(e.g. materials, subcontractor, tool rental, etc.)`;
    questionType = 'categorise';

  } else if (category === 'meals_entertainment') {
    questionText = `We found ${occurrenceStr} at "${display_name}" categorised as meals/entertainment. ` +
      `Were these business-related meals? If yes, who did you meet with and what was the purpose?`;
    questionType = 'business_purpose';

  } else if (category === 'travel_lodging') {
    questionText = `We found ${occurrenceStr} at "${display_name}" for travel/lodging. ` +
      `Was this travel for business? If yes, what job or project was it for?`;
    questionType = 'business_purpose';

  } else if (entry.category !== 'unknown') {
    questionText = `We found ${occurrenceStr} to "${display_name}". ` +
      `Can you confirm this was a business expense and describe its purpose?`;
    questionType = 'confirm_business';

  } else {
    return null;
  }

  return {
    id:              generateQuestionId(),
    question:        questionText,
    question_type:   questionType,
    merchant:        merchant,
    display_merchant: display_name,
    transaction_ids,
    total_amount:    parseFloat(total_amount.toFixed(2)),
    occurrences,
    answer:          null,
    resolved:        false,
  };
}

function generateQuestionId() {
  return 'q_' + Math.random().toString(36).slice(2, 10);
}

// ── FINANCIAL SUMMARY ─────────────────────────────────────────────────────────

function calculateSummary(transactions, questions) {
  let totalIncome       = 0;
  let totalIncome1099   = 0;
  let totalDeductions   = 0;
  let flaggedCount      = 0;

  for (const t of transactions) {
    const amount = parseFloat(t.amount) || 0;

    if (t.type === 'credit' && t.category === 'income_1099') {
      totalIncome     += amount;
      totalIncome1099 += amount;
    }

    if (t.is_business === true && DEDUCTIBLE_CATEGORIES.has(t.category)) {
      // Meals: only 50% deductible — flag at 50% of gross
      const deductible = t.category === 'meals_entertainment'
        ? amount * 0.5
        : amount;
      totalDeductions += deductible;
    }

    if (t.needs_clarification || t.consensus_score === 1) {
      flaggedCount++;
    }
  }

  const estimatedTaxSavings = parseFloat((totalDeductions * ESTIMATED_TAX_RATE).toFixed(2));

  return {
    total_income:           parseFloat(totalIncome.toFixed(2)),
    total_income_1099:      parseFloat(totalIncome1099.toFixed(2)),
    total_deductions:       parseFloat(totalDeductions.toFixed(2)),
    estimated_tax_savings:  estimatedTaxSavings,
    estimated_tax_rate_pct: ESTIMATED_TAX_RATE * 100,
    flagged_count:          flaggedCount,
    clarification_count:    questions.length,
    transaction_count:      transactions.length,
    note: 'Tax savings is an estimate at 28%. Consult a licensed CPA for final figures.',
  };
}

function buildEmptySummary() {
  return {
    total_income:           0,
    total_income_1099:      0,
    total_deductions:       0,
    estimated_tax_savings:  0,
    estimated_tax_rate_pct: ESTIMATED_TAX_RATE * 100,
    flagged_count:          0,
    clarification_count:    0,
    transaction_count:      0,
    note: 'Tax savings is an estimate at 28%. Consult a licensed CPA for final figures.',
  };
}