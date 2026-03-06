// src/services/agents/extractorAgent.js
//
// AGENT 1 — THE EXTRACTOR
//
// One job: get every single transaction out of the PDF exactly as it appears,
// line by line in the same order as the statement.
//
// NO categorisation here. Raw data only.
//
// If the math doesn't close after extraction, uses the ANCHOR CHAIN METHOD:
//   - Sends the PDF back to Gemini along with the JSON it already produced
//   - Says: "Here is what you found. Match every line you can see on the PDF
//     against this list. Tell me what is missing and why. Then give me the
//     complete corrected list."
//   - The model thinks through the discrepancy itself rather than blindly re-extracting
//   - Retries up to 3 times
//
// Saves raw output to a timestamped JSON file for inspection.

import fs   from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../../utils/logger.js';
import { parseExtractionResponse } from '../extractionPrompt.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';

const MAX_MATH_RETRIES  = 3;
const MATH_TOLERANCE    = 1.00; // $1 tolerance
const LOG_DIR           = path.join(process.cwd(), 'logs', 'extractions');

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
// Agent 1 only extracts. No categorisation. No guessing business purpose.
// Just get the raw data out, faithfully.

const EXTRACTION_SYSTEM_PROMPT = `You are a precise bank statement data extraction agent.

YOUR ONLY JOB: Extract every financial transaction from this bank statement exactly 
as it appears, line by line, in the same order as the statement.

RULES:
- Extract transactions IN ORDER — top to bottom, page by page
- Do NOT skip any transaction, no matter how small
- Do NOT categorise or classify — leave category as null
- Do NOT guess business purpose — leave is_business as null
- Descriptions must be EXACTLY as printed on the statement — do not clean or abbreviate
- Amounts must be positive numbers
- Dates in YYYY-MM-DD format
- If a date is missing for a transaction, use the nearest date visible on that page
- Extract the opening balance, closing balance, statement period, and account number

You must also extract the raw running balance after each transaction if it appears 
on the statement — this helps with math verification.

OUTPUT: Valid JSON only. No markdown. No explanation. No preamble.

{
  "account_number_last4": "1234" | null,
  "statement_period_start": "YYYY-MM-DD" | null,
  "statement_period_end": "YYYY-MM-DD" | null,
  "opening_balance": 1234.56 | null,
  "closing_balance": 1234.56 | null,
  "currency": "USD",
  "transactions": [
    {
      "line_number": 1,
      "date": "YYYY-MM-DD",
      "description": "EXACT TEXT FROM STATEMENT",
      "amount": 123.45,
      "type": "debit" | "credit",
      "running_balance": 5432.10 | null,
      "page_number": 1 | null
    }
  ],
  "extraction_notes": "any issues or null"
}`;

// ── ANCHOR CHAIN PROMPT ───────────────────────────────────────────────────────
// Used when math doesn't close. The model is given the PDF + its own output
// and asked to reason through what it missed.

function buildAnchorChainPrompt(previousJson, openingBalance, closingBalance, discrepancy, attempt) {
  return `You are reviewing your own bank statement extraction for accuracy.

MATH CHECK FAILED (attempt ${attempt} of ${MAX_MATH_RETRIES}):
- Opening balance:     $${openingBalance}
- Your extracted totals show closing balance should be: $${(parseFloat(openingBalance) + previousJson.transactions.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0) - previousJson.transactions.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)).toFixed(2)}
- Actual closing balance on statement: $${closingBalance}
- Discrepancy: $${discrepancy} (${discrepancy > 0 ? 'you extracted too much' : 'you are missing transactions'})

YOUR PREVIOUS EXTRACTION (${previousJson.transactions.length} transactions found):
${JSON.stringify(previousJson.transactions, null, 2)}

NOW DO THE FOLLOWING — think carefully, do not rush:

1. Go through the PDF page by page, line by line
2. For each transaction line you see on the PDF, check if it exists in your previous list above
3. Identify what is missing or incorrect — think about:
   - Transactions on continuation pages you may have skipped
   - Lines that wrapped across two rows
   - Transactions with unusual formatting
   - Fees or small charges buried in the statement
   - Any line with a dollar amount that is not in your list above
4. Correct any wrong amounts or dates you spot
5. Return the COMPLETE corrected transaction list — all previous transactions PLUS any you found

Be thorough. The math must close. Return valid JSON only using the same schema.`;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

/**
 * Run Agent 1 — raw extraction with math verification and anchor chain retry.
 *
 * @param {string} filePath     - Absolute path to PDF
 * @param {string} filename     - Original filename
 * @param {string} jobId        - For log file naming
 * @returns {object}            - Raw extraction result
 */
export async function runExtractorAgent(filePath, filename, jobId) {
  logger.info('[Agent 1] Extractor started', { filename, jobId });

  ensureLogDir();

  // ── Initial extraction ────────────────────────────────────────────────────
  let result = await extractRaw(filePath, filename);

  if (!result || result.transactions.length === 0) {
    logger.error('[Agent 1] Initial extraction returned nothing', { filename });
    saveJSON(jobId, filename, 'raw_failed', { error: 'No transactions extracted', result });
    return result || emptyResult('Extraction returned nothing');
  }

  saveJSON(jobId, filename, 'raw_attempt_1', result);
  logger.info('[Agent 1] Initial extraction complete', {
    filename,
    transactionCount: result.transactions.length,
    openingBalance:   result.opening_balance,
    closingBalance:   result.closing_balance,
  });

  // ── Math verification + anchor chain retry ────────────────────────────────
  for (let attempt = 1; attempt <= MAX_MATH_RETRIES; attempt++) {
    const mathCheck = verifyMath(result);

    if (mathCheck.closed) {
      logger.info('[Agent 1] Math verified ✓', { filename, attempt });
      break;
    }

    logger.warn(`[Agent 1] Math failed — discrepancy $${mathCheck.discrepancy}`, {
      filename,
      attempt,
      discrepancy: mathCheck.discrepancy,
    });

    if (attempt === MAX_MATH_RETRIES) {
      logger.warn('[Agent 1] Max retries reached — flagging for human review', { filename });
      result.math_failed      = true;
      result.math_discrepancy = mathCheck.discrepancy;
      result.extraction_notes = `Math did not close after ${MAX_MATH_RETRIES} attempts. Discrepancy: $${mathCheck.discrepancy}. Human review required.`;
      break;
    }

    // ── ANCHOR CHAIN: send PDF + previous JSON back to Gemini ──────────────
    logger.info(`[Agent 1] Running anchor chain attempt ${attempt + 1}`, { filename });

    const anchorPrompt = buildAnchorChainPrompt(
      result,
      result.opening_balance,
      result.closing_balance,
      mathCheck.discrepancy,
      attempt + 1
    );

    const corrected = await extractWithAnchor(filePath, filename, anchorPrompt);

    if (corrected && corrected.transactions.length >= result.transactions.length) {
      result = corrected;
      saveJSON(jobId, filename, `raw_attempt_${attempt + 1}`, result);
      logger.info(`[Agent 1] Anchor chain attempt ${attempt + 1} complete`, {
        filename,
        transactionCount: result.transactions.length,
      });
    } else {
      logger.warn(`[Agent 1] Anchor chain attempt ${attempt + 1} returned fewer transactions — keeping previous`, { filename });
    }
  }

  // ── Save final raw output ─────────────────────────────────────────────────
  saveJSON(jobId, filename, 'raw_final', result);

  logger.info('[Agent 1] Extractor complete', {
    filename,
    finalTransactionCount: result.transactions.length,
    mathClosed:            !result.math_failed,
  });

  return result;
}

// ── GEMINI CALLS ──────────────────────────────────────────────────────────────

async function extractRaw(filePath, filename) {
  const base64 = fs.readFileSync(filePath).toString('base64');

  const model = genAI.getGenerativeModel({
    model:             MODEL,
    generationConfig:  { temperature: 0.1, maxOutputTokens: 8192 },
    systemInstruction: EXTRACTION_SYSTEM_PROMPT,
  });

  const parts = [
    { inlineData: { mimeType: 'application/pdf', data: base64 } },
    { text: `Extract all transactions from this bank statement PDF exactly as they appear, line by line.\nFilename: ${filename}\nReturn valid JSON only.` },
  ];

  try {
    const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
    const raw    = result.response.text();
    return parseExtractionResponse(raw, true); // true = raw mode, preserve line_number + running_balance
  } catch (err) {
    logger.error('[Agent 1] Gemini extraction call failed', { filename, error: err.message });
    return null;
  }
}

async function extractWithAnchor(filePath, filename, anchorPrompt) {
  const base64 = fs.readFileSync(filePath).toString('base64');

  const model = genAI.getGenerativeModel({
    model:             MODEL,
    generationConfig:  { temperature: 0.2, maxOutputTokens: 16384 }, // slightly higher temp — needs reasoning
    systemInstruction: EXTRACTION_SYSTEM_PROMPT,
  });

  const parts = [
    { inlineData: { mimeType: 'application/pdf', data: base64 } },
    { text: anchorPrompt },
  ];

  try {
    const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
    const raw    = result.response.text();
    return parseExtractionResponse(raw, true);
  } catch (err) {
    logger.error('[Agent 1] Anchor chain call failed', { filename, error: err.message });
    return null;
  }
}

// ── MATH VERIFICATION ─────────────────────────────────────────────────────────

function verifyMath(result) {
  const { opening_balance, closing_balance, transactions } = result;

  if (opening_balance == null || closing_balance == null) {
    return { closed: true, discrepancy: null }; // can't verify — skip
  }

  const totalCredits = transactions
    .filter(t => t.type === 'credit')
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const totalDebits = transactions
    .filter(t => t.type === 'debit')
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const calculated  = parseFloat(opening_balance) + totalCredits - totalDebits;
  const discrepancy = parseFloat((calculated - parseFloat(closing_balance)).toFixed(2));
  const closed      = Math.abs(discrepancy) <= MATH_TOLERANCE;

  return { closed, discrepancy };
}

// ── FILE HELPERS ──────────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function saveJSON(jobId, filename, label, data) {
  try {
    const ts        = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName  = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath  = path.join(LOG_DIR, `${ts}_${safeName}_${label}.json`);

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`[Agent 1] JSON saved`, { file: path.basename(filePath) });
  } catch (err) {
    logger.warn('[Agent 1] Failed to save JSON log', { error: err.message });
  }
}

function emptyResult(note) {
  return {
    account_number_last4:   null,
    statement_period_start: null,
    statement_period_end:   null,
    opening_balance:        null,
    closing_balance:        null,
    currency:               'USD',
    transactions:           [],
    extraction_notes:       note,
    math_failed:            false,
  };
}