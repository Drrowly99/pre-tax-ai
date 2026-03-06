// src/services/agents/judgeAgent.js
//
// AGENT 3 — THE JUDGE
//
// Takes the categorised transaction list from Agent 2.
// Validates everything. Sends problems back to Agent 2 for correction.
//
// WHAT IT CHECKS:
// 1. Math verification — opening + credits - debits = closing
// 2. Category coherence — flags impossible combinations
//    (e.g. a $3 debit marked as income_1099)
// 3. Subcontractor audit — flags all subcontractor_labor for 1099-NEC review
// 4. Income sanity — large credits not marked income should be questioned
// 5. Confidence audit — bulk LOW confidence suggests something went wrong
//
// WHEN IT FINDS PROBLEMS:
// - Sends the problem transactions back to Agent 2 with specific instructions
// - Agent 2 re-categorises just those transactions
// - Judge merges corrections back in
// - Saves final output to JSON
//
// The judge does NOT call Gemini directly — it orchestrates Agent 2.

import fs   from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../../utils/logger.js';
import { TAX_CATEGORIES } from '../extractionPrompt.js';

const genAI   = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
const LOG_DIR = path.join(process.cwd(), 'logs', 'extractions');

const MATH_TOLERANCE          = 1.00;
const MAX_JUDGE_RETRY         = 2;
const LOW_CONF_THRESHOLD      = 0.4;  // if >40% of transactions are LOW confidence, re-review
const LARGE_CREDIT_THRESHOLD  = 500;  // credits over $500 not marked income get questioned

// ── JUDGE REVIEW PROMPT ───────────────────────────────────────────────────────

function buildJudgeReviewPrompt(problems, filename) {
  return `You are reviewing a set of transactions that were flagged as problematic 
by the validation agent after categorisation.

FILENAME: ${filename}

The following transactions need your careful re-review. For each one, the reason 
it was flagged is included in the "judge_flag" field. Think carefully about each:

${JSON.stringify(problems, null, 2)}

For each transaction:
- Re-examine the category assignment — was it correct?
- Fix any obvious errors
- If the flag mentions a coherence issue (e.g. small debit marked as income), correct it
- If you're still uncertain, set confidence to LOW and needs_clarification to true
- Preserve the "judge_flag" field in your output so the worker can see what was reviewed

Return the corrected transactions as a JSON array only. No markdown.`;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

/**
 * Run Agent 3 — validate and optionally send back to Agent 2 for re-review.
 *
 * @param {object} categorisedResult  - Output from Agent 2 (categoriserAgent)
 * @param {string} filename           - Original filename
 * @param {string} jobId              - For log file naming
 * @returns {object}                  - Final validated result
 */
export async function runJudgeAgent(categorisedResult, filename, jobId) {
  logger.info('[Agent 3] Judge started', {
    filename,
    transactionCount: categorisedResult.transactions?.length ?? 0,
  });

  ensureLogDir();

  let transactions = [...(categorisedResult.transactions || [])];
  let judgeNotes   = [];

  for (let round = 1; round <= MAX_JUDGE_RETRY; round++) {
    // ── Find problems ───────────────────────────────────────────────────────
    const problems = findProblems(transactions, categorisedResult);

    if (problems.length === 0) {
      logger.info(`[Agent 3] No problems found in round ${round}`, { filename });
      break;
    }

    logger.warn(`[Agent 3] Found ${problems.length} problems in round ${round}`, {
      filename,
      flags: [...new Set(problems.map(p => p.judge_flag))],
    });

    judgeNotes.push(`Round ${round}: ${problems.length} transactions re-reviewed`);

    // ── Send problems back to Gemini for re-categorisation ─────────────────
    const corrected = await requestCorrections(problems, filename);

    if (!corrected || corrected.length === 0) {
      logger.warn('[Agent 3] No corrections returned', { filename, round });
      break;
    }

    // ── Merge corrections back ──────────────────────────────────────────────
    for (const correction of corrected) {
      const idx = transactions.findIndex(t => t.line_number === correction.line_number);
      if (idx !== -1) {
        transactions[idx] = { ...transactions[idx], ...correction };
        logger.info('[Agent 3] Correction applied', {
          line:     correction.line_number,
          oldCat:   transactions[idx].category,
          newCat:   correction.category,
        });
      }
    }

    saveJSON(jobId, filename, `judge_round_${round}`, {
      ...categorisedResult,
      transactions,
      judge_notes: judgeNotes,
    });
  }

  // ── Final math check ──────────────────────────────────────────────────────
  const mathCheck = verifyMath(
    transactions,
    categorisedResult.opening_balance,
    categorisedResult.closing_balance
  );

  // ── Build final summaries ─────────────────────────────────────────────────
  const subcontractorWarnings = transactions
    .filter(t => t.category === 'subcontractor_labor')
    .map(t => ({
      description: t.description,
      amount:      t.amount,
      date:        t.date,
      note:        'Potential 1099-NEC required if annual total exceeds $600',
    }));

  const finalResult = {
    ...categorisedResult,
    transactions,
    math_closed:             mathCheck.closed,
    math_discrepancy:        mathCheck.discrepancy,
    missing_transaction_flag: !mathCheck.closed && Math.abs(mathCheck.discrepancy ?? 0) > 1,
    subcontractor_warnings:  subcontractorWarnings,
    judge_notes:             judgeNotes,
    models_used:             1,
    extraction_notes:        categorisedResult.extraction_notes || null,
  };

  saveJSON(jobId, filename, 'final', finalResult);

  logger.info('[Agent 3] Judge complete', {
    filename,
    totalTransactions:      transactions.length,
    mathClosed:             mathCheck.closed,
    mathDiscrepancy:        mathCheck.discrepancy,
    subcontractorWarnings:  subcontractorWarnings.length,
    needsClarification:     transactions.filter(t => t.needs_clarification).length,
  });

  return finalResult;
}

// ── PROBLEM DETECTION ─────────────────────────────────────────────────────────

function findProblems(transactions, result) {
  const problems = [];

  const lowConfCount = transactions.filter(t => t.confidence === 'LOW').length;
  const lowConfRatio = transactions.length > 0 ? lowConfCount / transactions.length : 0;

  for (const t of transactions) {

    // 1. Category coherence checks
    if (t.type === 'debit' && t.category === 'income_1099') {
      problems.push({
        ...t,
        judge_flag: 'COHERENCE: debit transaction cannot be income_1099 — debits are expenses',
      });
      continue;
    }

    if (t.type === 'credit' && ['fuel_mileage', 'materials_supplies', 'tools_equipment',
      'subcontractor_labor', 'dump_fees_disposal', 'permits_fees'].includes(t.category)) {
      problems.push({
        ...t,
        judge_flag: `COHERENCE: credit transaction marked as expense category "${t.category}" — credits are usually income or transfers`,
      });
      continue;
    }

    // 2. Large credit not marked as income or transfer
    if (t.type === 'credit' &&
        parseFloat(t.amount) > LARGE_CREDIT_THRESHOLD &&
        !['income_1099', 'transfer', 'personal'].includes(t.category) &&
        t.confidence !== 'HIGH') {
      problems.push({
        ...t,
        judge_flag: `INCOME_CHECK: large credit of $${t.amount} not categorised as income or transfer — verify this is correct`,
      });
      continue;
    }

    // 3. Unknown category with no clarification flag
    if (t.category === 'unknown' && !t.needs_clarification) {
      problems.push({
        ...t,
        judge_flag: 'MISSING_FLAG: unknown category should have needs_clarification set to true',
      });
      continue;
    }

    // 4. Subcontractor missing needs_clarification flag
    if (t.category === 'subcontractor_labor' && !t.needs_clarification) {
      problems.push({
        ...t,
        judge_flag: 'SUBCONTRACTOR: subcontractor_labor must have needs_clarification true for 1099-NEC review',
      });
      continue;
    }

    // 5. Bulk LOW confidence — if ratio is high, re-review all LOW ones
    if (lowConfRatio > LOW_CONF_THRESHOLD && t.confidence === 'LOW') {
      problems.push({
        ...t,
        judge_flag: `LOW_CONF_BULK: ${Math.round(lowConfRatio * 100)}% of transactions are LOW confidence — re-review this one`,
      });
    }
  }

  return problems;
}

// ── GEMINI CORRECTION CALL ────────────────────────────────────────────────────

async function requestCorrections(problems, filename) {
  const model = genAI.getGenerativeModel({
    model:             MODEL,
    generationConfig:  { temperature: 0.2, maxOutputTokens: 8192 },
    systemInstruction: `You are a tax categorisation correction agent. 
You receive flagged transactions and fix the issues identified.
Return only the corrected transactions as a JSON array. No markdown.
Preserve all original fields. Update category, confidence, is_business, 
needs_clarification, and notes as needed.`,
  });

  try {
    const result = await model.generateContent([
      { text: buildJudgeReviewPrompt(problems, filename) },
    ]);
    const raw   = result.response.text();
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : parsed.transactions || [];
  } catch (err) {
    logger.error('[Agent 3] Correction request failed', { filename, error: err.message });
    return [];
  }
}

// ── MATH ──────────────────────────────────────────────────────────────────────

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
  return { closed: Math.abs(discrepancy) <= MATH_TOLERANCE, discrepancy };
}

// ── FILE HELPERS ──────────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function saveJSON(jobId, filename, label, data) {
  try {
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(LOG_DIR, `${ts}_${safeName}_${label}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`[Agent 3] JSON saved`, { file: path.basename(filePath) });
  } catch (err) {
    logger.warn('[Agent 3] Failed to save JSON log', { error: err.message });
  }
}