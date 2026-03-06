// taxprep_pipeline.js  v3.0
// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURE:
//   Agent 1 — EXTRACTOR         gemini-3.1-pro-preview  (thinking: high)
//             Line-by-line, anchor chain math verification, 3 retries
//
//   Agent 2 — JUDGE             Pure JS — no AI call
//             Validates anchor chain, flags issues, builds correction prompt
//
//   Agent 3 — CATEGORISER       gemini-3-flash-preview  (+ Google Search)
//             Categorises all transactions, searches unknowns autonomously
//             Uses client instructions to resolve known people/payments
//             Applies learned patterns from prior months to save tokens
//
// OUTPUT FILES (./output/):
//   <ts>_attempt1_extract.json       Raw Agent 1 result
//   <ts>_judge_verdict.json          Agent 2 validation report
//   <ts>_categorized_FINAL.json      Full structured output
//   <ts>_NOTIFICATIONS.json          Email/alert flags for client
//   <ts>_QUESTIONNAIRE.json          Client questionnaire form
//   <ts>_REPORT.xlsx                 Excel workbook (multi-sheet)
//
// SDK: @google/genai (NOT @google/generative-ai)
// Run: node taxprep_pipeline.js "jan.pdf" "feb.pdf"
// ═══════════════════════════════════════════════════════════════════════════

import { GoogleGenAI }         from '@google/genai';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath }       from 'url';
import ExcelJS                 from 'exceljs';
import 'dotenv/config';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
mkdirSync(OUTPUT_DIR, { recursive: true });

// ── MODELS ───────────────────────────────────────────────────────────────────
const MODEL_PRO   = 'gemini-3.1-pro-preview';   // Agent 1 — thinking, deep reasoning
const MODEL_FLASH = 'gemini-3.1-flash-lite-preview';    // Agent 3 — fast, search-enabled

// ── CONFIG ───────────────────────────────────────────────────────────────────
const PDF_PATHS      = process.argv.slice(2);
const MAX_RETRIES    = 3;
const MATH_TOLERANCE = 0.05;

// ── CLIENT INSTRUCTIONS ──────────────────────────────────────────────────────
// Pre-loaded facts about people and payments that the categoriser will use
// In production this comes from the job record — here it's hardcoded for test
const CLIENT_INSTRUCTIONS = `
The following are known facts provided by the account holder — apply them:

KNOWN CONTRACTORS (require 1099-NEC if paid $600+ in year):
  - TOM HAROLD      → SUBCONTRACTOR. Generate 1099-NEC flag.
  - EMILY GRACE     → SUBCONTRACTOR. Generate 1099-NEC flag.
  - FRIDAY          → SUBCONTRACTOR (individual contractor payments). Flag 1099-NEC.

KNOWN PERSONAL (NOT business expenses):
  - KAYLA           → PERSONAL. This is the account holder's daughter. Not deductible.

KNOWN TRANSFERS (NOT income):
  - SIMON           → TRANSFER_INTERNAL / PERSONAL_REPAYMENT.
                      Simon sent money and asked it be paid back. This is a loan repayment,
                      NOT income and NOT a business expense.

Any payment matching these names should be categorised accordingly with HIGH confidence.
Do not question these — the account holder has confirmed them.
`.trim();

// ── VALIDATION ────────────────────────────────────────────────────────────────
if (PDF_PATHS.length === 0) {
  console.error('\n  Usage: node taxprep_pipeline.js "jan.pdf" "feb.pdf"\n');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('\n  ERROR: GEMINI_API_KEY not set in .env\n');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN TRACKER — separates Pro vs Flash
// ═══════════════════════════════════════════════════════════════════════════
const tok = {
  pro:   { calls: [], input: 0, output: 0, thinking: 0 },
  flash: { calls: [], input: 0, output: 0 },

  record(model, label, meta) {
    if (!meta) return;
    const bucket = model.includes('pro') ? this.pro : this.flash;
    const i = meta.promptTokenCount     || 0;
    const o = meta.candidatesTokenCount || 0;
    const t = meta.thoughtsTokenCount   || 0;  // thinking tokens (Pro only)
    bucket.calls.push({ label, input: i, output: o, thinking: t });
    bucket.input    += i;
    bucket.output   += o;
    bucket.thinking += t;
  },

  print() {
    const pad = (s, n) => String(s).padEnd(n);
    const rpad = (s, n) => String(s).padStart(n);

    console.log('\n  ┌─────────────────────────────────────────────────────────────────┐');
    console.log('  │                     TOKEN USAGE SUMMARY                         │');
    console.log('  ├──────────────────────────────┬────────┬────────┬────────┬───────┤');
    console.log('  │ Call                         │  Input │ Output │Thinking│ Total │');
    console.log('  ├──────────────────────────────┼────────┼────────┼────────┼───────┤');

    console.log('  │ ── 3.1 PRO (thinking) ──     │        │        │        │       │');
    this.pro.calls.forEach(c => {
      const total = c.input + c.output + c.thinking;
      console.log(`  │ ${pad(c.label,30)} │${rpad(c.input,7)} │${rpad(c.output,7)} │${rpad(c.thinking,7)} │${rpad(total,6)} │`);
    });
    const proTotal = this.pro.input + this.pro.output + this.pro.thinking;
    console.log(`  │ ${pad('PRO SUBTOTAL',30)} │${rpad(this.pro.input,7)} │${rpad(this.pro.output,7)} │${rpad(this.pro.thinking,7)} │${rpad(proTotal,6)} │`);

    console.log('  ├──────────────────────────────┼────────┼────────┼────────┼───────┤');
    console.log('  │ ── 3.0 FLASH (search) ──     │        │        │        │       │');
    this.flash.calls.forEach(c => {
      const total = c.input + c.output;
      console.log(`  │ ${pad(c.label,30)} │${rpad(c.input,7)} │${rpad(c.output,7)} │${rpad('-',7)} │${rpad(total,6)} │`);
    });
    const flashTotal = this.flash.input + this.flash.output;
    console.log(`  │ ${pad('FLASH SUBTOTAL',30)} │${rpad(this.flash.input,7)} │${rpad(this.flash.output,7)} │${rpad('-',7)} │${rpad(flashTotal,6)} │`);

    console.log('  ├──────────────────────────────┼────────┼────────┼────────┼───────┤');
    const grandTotal = proTotal + flashTotal;
    console.log(`  │ ${pad('GRAND TOTAL',30)} │        │        │        │${rpad(grandTotal,6)} │`);
    console.log('  └──────────────────────────────┴────────┴────────┴────────┴───────┘');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function ts() { return new Date().toISOString().replace('T','_').replace(/:/g,'-').slice(0,19); }

function saveJSON(data, label) {
  const fn = `${ts()}_${label}.json`;
  writeFileSync(join(OUTPUT_DIR, fn), JSON.stringify(data, null, 2), 'utf8');
  console.log(`  💾 ${fn}`);
  return fn;
}

function cleanJSON(raw) {
  return raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '').trim();
}

function toFloat(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const p = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(p) ? 0 : p;
}

function sanitizeExtraction(ext) {
  ext.opening_balance = toFloat(ext.opening_balance);
  ext.closing_balance = toFloat(ext.closing_balance);
  (ext.transactions || []).forEach(t => {
    t.amount          = toFloat(t.amount);
    t.running_balance = toFloat(t.running_balance);
    t.type            = (t.type || '').toUpperCase();
    if (!['DEBIT','CREDIT'].includes(t.type)) t.type = 'DEBIT';
  });
  return ext;
}

// ── PATTERN CACHE ─────────────────────────────────────────────────────────────
// After month 1, we store categorised merchants so month 2 is cheaper
const patternCache = new Map(); // "description_prefix" → {tax_category, is_business, confidence}

function learnPatterns(categorizedTxs) {
  categorizedTxs.forEach(t => {
    if (!t.tax_category || t.tax_category.startsWith('UNCLEAR')) return;
    const key = (t.description || '').slice(0, 20).toLowerCase().trim();
    if (key.length > 3) {
      patternCache.set(key, {
        tax_category: t.tax_category,
        is_business:  t.is_business,
        confidence:   t.confidence,
      });
    }
  });
  console.log(`  🧠 Pattern cache updated: ${patternCache.size} known merchants`);
}

function buildCacheContext() {
  if (patternCache.size === 0) return '';
  const entries = [...patternCache.entries()]
    .slice(0, 80) // cap to avoid token bloat
    .map(([k, v]) => `  "${k}" → ${v.tax_category} (${v.confidence}, business:${v.is_business})`)
    .join('\n');
  return `\nKNOWN MERCHANTS FROM PRIOR MONTHS (use these, don't re-research):\n${entries}\n`;
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT 1 — EXTRACTOR  (gemini-3.1-pro-preview with thinking)
// ═══════════════════════════════════════════════════════════════════════════
async function agent1_extract(pdfPath, correctionPrompt = null, attempt = 1) {
  const label = `Agent1 attempt${attempt}`;
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 1 — EXTRACTOR  [${MODEL_PRO}]  attempt ${attempt}/${MAX_RETRIES}`);
  console.log(`${'═'.repeat(65)}`);

  const pdfBase64 = readFileSync(pdfPath).toString('base64');

  let prompt = `You are a precise bank statement extraction specialist.

Extract EVERY transaction line by line in the EXACT ORDER they appear on the statement.

═══ ANCHOR CHAIN — CRITICAL ═══
Every transaction MUST have running_balance = the exact balance after that transaction.
If the PDF shows a running balance column, use it exactly.
If not shown, calculate it yourself:
  CREDIT: running_balance[n] = running_balance[n-1] + amount
  DEBIT:  running_balance[n] = running_balance[n-1] - amount
Starting value = opening_balance.
This is the mechanism we use to prove every transaction was captured.

═══ EXTRACTION RULES ═══
1. Extract EVERYTHING — fees, reversals, transfers, interest, ATM, ACH, wire, NSF, all of it
2. Exact document order — do not reorder
3. EXACT description text as it appears (do not clean, abbreviate, or interpret)
4. Amounts always POSITIVE. type = DEBIT or CREDIT
5. Multi-line entries: combine into one, use raw_line for full original text
   Property preservation payments often span 2-3 lines — combine all lines
6. Dates: YYYY-MM-DD format. If date missing, inherit nearest date above
7. line_number starts at 1 and is sequential
8. page_number = which page of the PDF this transaction appeared on

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON. No markdown. No explanation. Exact schema:

{
  "account_holder_name": "",
  "account_number_last4": "",
  "account_type": "CHECKING",
  "bank_name": "",
  "statement_period_start": "YYYY-MM-DD",
  "statement_period_end": "YYYY-MM-DD",
  "opening_balance": 0.00,
  "closing_balance": 0.00,
  "currency": "USD",
  "transactions": [
    {
      "line_number": 1,
      "page_number": 1,
      "date": "YYYY-MM-DD",
      "description": "EXACT TEXT FROM STATEMENT",
      "amount": 0.00,
      "type": "DEBIT or CREDIT",
      "running_balance": 0.00,
      "raw_line": "full original line text from PDF"
    }
  ],
  "transaction_count": 0,
  "total_credits": 0.00,
  "total_debits": 0.00,
  "extraction_notes": ""
}`;

  if (correctionPrompt) {
    prompt += `\n\n${'═'.repeat(50)}\n⚠️  CORRECTIONS FROM JUDGE — FIX ALL OF THESE:\n${'═'.repeat(50)}\n${correctionPrompt}\n\nReturn the COMPLETE corrected JSON including all transactions.`;
  }

  try {
    console.log(`  📄 Sending PDF to ${MODEL_PRO} with thinking enabled...`);

    const response = await ai.models.generateContent({
      model:    MODEL_PRO,
      contents: [
        {
          role:  'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        thinkingConfig: { thinkingLevel: 'high' },  // Gemini 3.1 Pro — maximum reasoning
      },
    });

    tok.record(MODEL_PRO, label, response.usageMetadata);

    let ext;
    try {
      ext = JSON.parse(cleanJSON(response.text));
    } catch (e) {
      saveJSON({ raw: response.text, error: e.message }, `attempt${attempt}_PARSE_FAILED`);
      throw new Error(`Agent 1 JSON parse failed: ${e.message}`);
    }

    ext = sanitizeExtraction(ext);
    ext._meta = {
      attempt,
      extracted_at:   new Date().toISOString(),
      source_file:    basename(pdfPath),
      model:          MODEL_PRO,
      had_corrections: !!correctionPrompt,
    };

    saveJSON(ext, `attempt${attempt}_extract`);
    console.log(`  ✅ ${ext.transactions?.length ?? 0} transactions  |  ${ext.statement_period_start} → ${ext.statement_period_end}`);
    console.log(`     Opening: $${ext.opening_balance}  →  Closing: $${ext.closing_balance}`);
    return ext;

  } catch (err) {
    console.error(`  ❌ Agent 1 failed: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT 2 — JUDGE  (pure JS, no AI)
// ═══════════════════════════════════════════════════════════════════════════
function agent2_judge(ext, fileLabel = '') {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 2 — JUDGE  [Pure JS]${fileLabel ? '  '+fileLabel : ''}`);
  console.log(`${'═'.repeat(65)}`);

  const issues   = [];
  const warnings = [];
  const txs      = ext.transactions || [];

  // ── ANCHOR CHAIN VERIFICATION ─────────────────────────────────────────────
  if (ext.opening_balance != null && txs.length > 0) {
    let expected = toFloat(ext.opening_balance);
    let breaks   = 0;

    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      expected = tx.type === 'CREDIT'
        ? parseFloat((expected + tx.amount).toFixed(2))
        : parseFloat((expected - tx.amount).toFixed(2));

      const stated = toFloat(tx.running_balance);
      const diff   = Math.abs(expected - stated);

      if (stated !== 0 && diff > MATH_TOLERANCE) {
        breaks++;
        issues.push({
          severity: 'CRITICAL',
          type:     'ANCHOR_CHAIN_BREAK',
          message:  `Chain broke at line ${tx.line_number}: expected $${expected} got $${stated} (off by $${diff.toFixed(2)})`,
          detail:   `Re-read the section between line ${i > 0 ? txs[i-1].line_number : 'start'} and line ${tx.line_number}. Something is missing or wrong in that range.`,
          line_number: tx.line_number,
        });
        expected = stated; // reset to keep finding further breaks
      }
    }

    if (breaks === 0 && ext.closing_balance != null) {
      const cdiff = Math.abs(expected - toFloat(ext.closing_balance));
      if (cdiff > MATH_TOLERANCE) {
        issues.push({
          severity: 'CRITICAL',
          type:     'CLOSING_MISMATCH',
          message:  `Closing balance: calculated $${expected} vs stated $${ext.closing_balance} (diff $${cdiff.toFixed(2)})`,
          detail:   `All individual running balances are internally consistent but the final total is off. Missing transaction(s) near the end of the statement.`,
        });
      } else {
        console.log(`  ✅ Anchor chain OK — all ${txs.length} running balances verified`);
      }
    }
  }

  if (txs.length === 0) {
    issues.push({ severity: 'CRITICAL', type: 'EMPTY', message: 'No transactions extracted.' });
  }

  // ── PER-TRANSACTION CHECKS ────────────────────────────────────────────────
  txs.forEach(tx => {
    if (!tx.amount || tx.amount <= 0)
      issues.push({ severity: 'HIGH', type: 'INVALID_AMOUNT', message: `Line ${tx.line_number}: zero or missing amount — "${tx.description}"` });
    if (!tx.date)
      issues.push({ severity: 'HIGH', type: 'MISSING_DATE',   message: `Line ${tx.line_number}: missing date — "${tx.description}"` });
    if (!['DEBIT','CREDIT'].includes(tx.type))
      issues.push({ severity: 'HIGH', type: 'INVALID_TYPE',   message: `Line ${tx.line_number}: invalid type "${tx.type}" — "${tx.description}"` });
  });

  // ── DUPLICATE DETECTION ───────────────────────────────────────────────────
  const seen = {};
  txs.forEach(tx => {
    const k = `${tx.date}_${tx.amount}_${(tx.description||'').slice(0,15).toLowerCase()}`;
    if (seen[k] != null)
      warnings.push(`Possible duplicate: lines ${seen[k]} and ${tx.line_number} — "${tx.description}" $${tx.amount}`);
    else
      seen[k] = tx.line_number;
  });

  const critical = issues.filter(i => i.severity === 'CRITICAL');
  const high     = issues.filter(i => i.severity === 'HIGH');
  const approved = critical.length === 0 && high.length === 0;

  console.log(`\n  📋 CHECKS SUMMARY:`);
  console.log(`     Transactions:    ${txs.length}`);
  console.log(`     Critical issues: ${critical.length}`);
  console.log(`     High issues:     ${high.length}`);
  console.log(`     Warnings:        ${warnings.length}`);
  console.log(approved ? '\n  ✅ APPROVED — proceeding to categorisation' : '\n  ❌ REJECTED — sending corrections to Agent 1');
  issues.forEach(i  => console.log(`     [${i.severity}] ${i.message}`));
  warnings.forEach(w => console.log(`  ⚠️   ${w}`));

  saveJSON({
    approved, issues, warnings,
    stats: {
      count:        txs.length,
      credits:      txs.filter(t => t.type==='CREDIT').reduce((s,t)=>s+t.amount,0).toFixed(2),
      debits:       txs.filter(t => t.type==='DEBIT').reduce((s,t) =>s+t.amount,0).toFixed(2),
      dupWarnings:  warnings.length,
    },
  }, `judge_verdict${fileLabel ? '_'+fileLabel.replace(/\W/g,'_') : ''}`);

  // Build correction prompt for Agent 1
  let correctionPrompt = null;
  if (!approved) {
    const lines = [`${issues.length} problem(s) to fix:\n`];
    issues.forEach((issue, i) => {
      lines.push(`${i+1}. [${issue.severity}] ${issue.message}`);
      if (issue.detail) lines.push(`   → ${issue.detail}`);
    });
    if (warnings.length) {
      lines.push('\nAlso review these warnings:');
      warnings.forEach(w => lines.push(`- ${w}`));
    }
    lines.push('\nReturn the COMPLETE corrected JSON with ALL transactions.');
    correctionPrompt = lines.join('\n');
  }

  return { approved, correctionPrompt };
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT 3 — CATEGORISER  (gemini-3-flash-preview + Google Search)
// ═══════════════════════════════════════════════════════════════════════════
async function agent3_categorize(mergedExt) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 3 — CATEGORISER  [${MODEL_FLASH} + Google Search]`);
  console.log(`${'═'.repeat(65)}`);

  const txs = mergedExt.transactions || [];
  console.log(`  🔍 Categorising ${txs.length} transactions`);
  if (patternCache.size > 0)
    console.log(`  🧠 ${patternCache.size} merchants already known from prior months — token savings applied`);

  const cacheContext = buildCacheContext();

  const prompt = `You are a US tax categorisation specialist for 1099 property preservation contractors.
You have Google Search available — use it for ANY merchant or code you don't recognise.

${'═'.repeat(50)}
CLIENT INSTRUCTIONS — APPLY THESE EXACTLY:
${'═'.repeat(50)}
${CLIENT_INSTRUCTIONS}

${'═'.repeat(50)}
TAX CATEGORIES — use only these exact codes:
${'═'.repeat(50)}
INCOME_1099          — Property preservation companies (Safeguard, MCS, Cyprexx, Five Brothers, Altisource, FAS, VRM, Assurant, CWIS, Berghorst, Chronos, Servicelink)
INCOME_OTHER         — Other business income, refunds, rebates
FUEL                 — Gas stations (Shell, BP, QT, Wawa, Circle K, Chevron, Sunoco, Murphy)
VEHICLE_REPAIR       — AutoZone, O'Reilly, NAPA, Jiffy Lube, Firestone, Pep Boys
VEHICLE_INSURANCE    — Car/truck insurance premiums
VEHICLE_PAYMENT      — Auto loan/lease payments
PARKING_TOLLS        — Parking meters, lots, EZPass, tolls
TOOLS_EQUIPMENT      — Home Depot, Lowe's, Ace Hardware, Harbor Freight, Menards, Fastenal
EQUIPMENT_RENTAL     — United Rentals, Sunbelt, Ahern
JOB_SUPPLIES         — Materials, lumber, pipe, concrete for specific jobs
SAFETY_GEAR          — Boots, gloves, hard hat, PPE, safety vests
UNIFORMS             — Work shirts, branded clothing
PHONE                — Cell phone bill (AT&T, Verizon, T-Mobile, Metro, Cricket)
INTERNET             — Internet service (Comcast, Spectrum, Cox, AT&T Internet)
SOFTWARE             — Business apps, subscriptions (QuickBooks, Google Workspace)
OFFICE_SUPPLIES      — Printer ink, paper, pens, folders
SHIPPING             — FedEx, UPS, USPS
SUBCONTRACTOR        — Zelle/Venmo/CashApp/PayPal to individuals over $200. FLAG for 1099-NEC.
PROFESSIONAL_FEES    — Accountant, lawyer, notary
INSURANCE_BUSINESS   — Liability insurance, workers comp, commercial insurance
LICENSING            — Business permits, contractor licenses, registrations
MEALS_BUSINESS       — Meals while travelling for work (50% deductible)
MEALS_PERSONAL       — Personal dining, restaurants
PERSONAL_GROCERY     — Grocery stores (Kroger, Publix, Aldi, Food Lion, Walmart Grocery)
PERSONAL_RETAIL      — Amazon, Target, Costco, Walmart (non-grocery)
PERSONAL_HEALTHCARE  — Pharmacy, doctor, hospital, CVS, Walgreens (med purchases)
BANKING_FEE          — Bank service fees, ATM fees, overdraft fees, wire fees
TRANSFER_INTERNAL    — Transfers to self, between own accounts
PERSONAL_REPAYMENT   — Loan repayment, returning money to someone
PERSONAL_OTHER       — Other personal expenses
UNCLEAR_MIXED_USE    — Could be business or personal (Walmart, Costco, Amazon — clarify)
UNCLEAR_CASH_ATM     — ATM withdrawals — ask how cash was used
UNCLEAR_UNKNOWN      — Searched Google, still unclear — explain what was found

${'═'.repeat(50)}
${cacheContext}
${'═'.repeat(50)}

TRANSACTIONS TO CATEGORISE:
${JSON.stringify(txs.map(t => ({
  line_number:  t.line_number,
  date:         t.date,
  description:  t.description,
  amount:       t.amount,
  type:         t.type,
  source_file:  t._source_file,
})), null, 2)}

Return a JSON array — one entry per transaction:
[{
  "line_number": 1,
  "tax_category": "CATEGORY_CODE",
  "is_business": true,
  "confidence": "HIGH",
  "needs_clarification": false,
  "clarification_reason": null,
  "suggested_answer": null,
  "source_citations": null,
  "categorization_note": "one-sentence reason"
}]

For needs_clarification=true, also set suggested_answer with what you think the answer most likely is.
For SUBCONTRACTOR entries, set needs_clarification=true and note 1099-NEC requirement.
For source_citations: [{query, finding}] if you searched, else null.`;

  try {
    const response = await ai.models.generateContent({
      model:    MODEL_FLASH,
      contents: prompt,
      config: {
        temperature: 0.2,
        tools: [{ googleSearch: {} }],
      },
    });

    tok.record(MODEL_FLASH, 'Agent3 Categoriser', response.usageMetadata);

    // Log searches Gemini performed
    const searches = response.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
    if (searches.length > 0) {
      console.log(`\n  🌐 Gemini searched Google ${searches.length} time(s):`);
      searches.forEach(q => console.log(`     → "${q}"`));
    } else {
      console.log('  ℹ️  Categorised from built-in knowledge + pattern cache');
    }

    let categorized;
    try {
      categorized = JSON.parse(cleanJSON(response.text));
    } catch (e) {
      saveJSON({ raw: response.text, error: e.message }, 'categorizer_PARSE_FAILED');
      throw new Error(`Agent 3 JSON parse failed: ${e.message}`);
    }

    if (!Array.isArray(categorized)) throw new Error('Agent 3 did not return an array');

    // Merge categorisation back onto raw transaction data
    const byLine = {};
    txs.forEach(t => { byLine[t.line_number] = t; });
    const merged = categorized.map(c => ({ ...byLine[c.line_number], ...c }));

    // Update pattern cache for future months
    learnPatterns(merged);

    // Build derived outputs
    const questions     = buildQuestionnaire(merged);
    const notifications = buildNotifications(merged, mergedExt);
    const summary       = buildSummary(merged);

    const final = {
      ...mergedExt,
      transactions: merged,
      summary,
      client_questions:  questions,
      notifications,
      _categorization_meta: {
        categorized_at: new Date().toISOString(),
        model:          MODEL_FLASH,
        google_searches: searches,
        search_count:   searches.length,
        pattern_cache_size: patternCache.size,
      },
    };

    saveJSON(final,         'categorized_FINAL');
    saveJSON(questions,     'QUESTIONNAIRE');
    saveJSON(notifications, 'NOTIFICATIONS');

    await buildExcel(final);

    // Console summary
    console.log('\n  📊 Category breakdown:');
    Object.entries(summary.by_category)
      .sort(([,a],[,b]) => b.total - a.total)
      .forEach(([cat, v]) => {
        console.log(`     ${cat.padEnd(25)} ${String(v.count).padStart(4)} tx   $${v.total.toFixed(2).padStart(12)}`);
      });

    if (questions.length > 0) {
      console.log(`\n  ❓ ${questions.length} client question(s) generated`);
      questions.slice(0, 5).forEach((q, i) => console.log(`     ${i+1}. ${q.question}`));
      if (questions.length > 5) console.log(`     ... and ${questions.length - 5} more`);
    }

    return final;

  } catch (err) {
    console.error(`  ❌ Agent 3 failed: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// QUESTIONNAIRE BUILDER
// Groups clarification items intelligently — one question per merchant
// ═══════════════════════════════════════════════════════════════════════════
function buildQuestionnaire(txs) {
  const groups = {};

  txs.filter(t => t.needs_clarification).forEach(t => {
    const key = (t.description || '').slice(0, 20).toLowerCase().trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  return Object.values(groups).map(grp => {
    const first = grp[0];
    const count = grp.length;
    const total = grp.reduce((s, t) => s + (t.amount || 0), 0);
    const dates = [...new Set(grp.map(t => t.date))].slice(0, 3).join(', ');
    const cat   = first.tax_category;

    let question, hint;

    if (cat === 'UNCLEAR_MIXED_USE') {
      question = count === 1
        ? `The ${first.description} purchase on ${first.date} for $${first.amount?.toFixed(2)} — was this for job supplies, tools, or materials? Or was it a personal purchase?`
        : `You have ${count} purchases at ${first.description} totaling $${total.toFixed(2)} on (${dates}). Were any of these for job supplies or business use?`;
      hint = first.suggested_answer || 'If any portion was for business, please specify which visits and what was purchased.';

    } else if (cat === 'UNCLEAR_CASH_ATM') {
      question = count === 1
        ? `ATM withdrawal of $${first.amount?.toFixed(2)} on ${first.date} — was this cash used for business? (e.g., paying a helper, buying supplies, fuel)`
        : `${count} ATM withdrawals totaling $${total.toFixed(2)} (${dates}) — were any of these used for business purposes?`;
      hint = 'Cash paid to workers, for supplies, or for job-related expenses can be deductible.';

    } else if (cat === 'SUBCONTRACTOR') {
      question = `Payment to "${first.description}" on ${first.date} for $${first.amount?.toFixed(2)} — please confirm: is this person a contractor you paid for job work? If yes, we may need to file a 1099-NEC for them if their annual total reaches $600.`;
      hint = first.suggested_answer || 'Please provide their full legal name and last 4 of SSN or EIN for 1099 filing.';

    } else if (first.clarification_reason) {
      question = `"${first.description}" on ${first.date} for $${first.amount?.toFixed(2)}: ${first.clarification_reason}`;
      hint = first.suggested_answer || null;

    } else {
      question = `Please clarify "${first.description}" on ${first.date} for $${first.amount?.toFixed(2)} — is this a business expense or personal?`;
      hint = first.suggested_answer || null;
    }

    return {
      question,
      hint,
      tax_category:      cat,
      transaction_count: count,
      total_amount:      parseFloat(total.toFixed(2)),
      line_numbers:      grp.map(t => t.line_number),
      dates:             grp.map(t => t.date),
      merchant:          first.description,
      source_citations:  first.source_citations || null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION BUILDER
// Produces structured flags for email alerts to client/tax preparer
// ═══════════════════════════════════════════════════════════════════════════
function buildNotifications(txs, ext) {
  const notifications = [];

  // 1. Math warning
  if (ext._math_warning) {
    notifications.push({
      type:     'MATH_WARNING',
      severity: 'HIGH',
      subject:  'Statement math did not fully reconcile',
      message:  ext._math_warning,
      action:   'Review the flagged statement manually. Some transactions may be missing.',
    });
  }

  // 2. 1099-NEC candidates
  const subcontractors = {};
  txs.filter(t => t.tax_category === 'SUBCONTRACTOR').forEach(t => {
    const key = (t.description || '').toLowerCase().trim();
    if (!subcontractors[key]) subcontractors[key] = { name: t.description, total: 0, transactions: [] };
    subcontractors[key].total        += t.amount || 0;
    subcontractors[key].transactions.push({ date: t.date, amount: t.amount, line: t.line_number });
  });

  Object.values(subcontractors).forEach(sc => {
    const flag = sc.total >= 600;
    notifications.push({
      type:          '1099_NEC_CANDIDATE',
      severity:      flag ? 'HIGH' : 'MEDIUM',
      subject:       `Subcontractor: ${sc.name}`,
      message:       `Total payments to "${sc.name}": $${sc.total.toFixed(2)}. ${flag ? '⚠️  EXCEEDS $600 threshold — 1099-NEC REQUIRED.' : 'Does not yet reach $600 threshold.'}`,
      action:        flag ? 'Collect full legal name + SSN/EIN and prepare 1099-NEC.' : 'Monitor. Will require 1099-NEC if total reaches $600.',
      total_paid:    parseFloat(sc.total.toFixed(2)),
      threshold_met: flag,
      transactions:  sc.transactions,
    });
  });

  // 3. Clarification items
  const needsClarif = txs.filter(t => t.needs_clarification && t.tax_category !== 'SUBCONTRACTOR');
  if (needsClarif.length > 0) {
    notifications.push({
      type:     'CLIENT_RESPONSE_NEEDED',
      severity: 'MEDIUM',
      subject:  `${needsClarif.length} transaction(s) need client clarification`,
      message:  `These transactions could not be definitively categorised. Client input is required before the return can be filed.`,
      action:   'Send the questionnaire to the client. Do not file until responses received.',
      count:    needsClarif.length,
      total:    parseFloat(needsClarif.reduce((s,t) => s+(t.amount||0),0).toFixed(2)),
    });
  }

  // 4. Large unidentified credits
  const largeUnknownCredits = txs.filter(t =>
    t.type === 'CREDIT' &&
    t.amount > 500 &&
    !['INCOME_1099','INCOME_OTHER','TRANSFER_INTERNAL','PERSONAL_REPAYMENT'].includes(t.tax_category)
  );
  largeUnknownCredits.forEach(t => {
    notifications.push({
      type:     'UNVERIFIED_INCOME',
      severity: 'HIGH',
      subject:  `Large unverified credit: $${t.amount} — "${t.description}"`,
      message:  `A credit of $${t.amount} on ${t.date} from "${t.description}" was not identified as known income. This could be unreported income.`,
      action:   'Confirm source with client before filing.',
      line_number: t.line_number,
    });
  });

  // 5. High-value deductions summary
  const topDeductions = Object.entries(
    txs.filter(t => t.is_business === true && t.type === 'DEBIT')
      .reduce((acc, t) => {
        const cat = t.tax_category;
        acc[cat] = (acc[cat] || 0) + (t.amount || 0);
        return acc;
      }, {})
  ).sort(([,a],[,b]) => b - a).slice(0, 5);

  if (topDeductions.length > 0) {
    notifications.push({
      type:     'DEDUCTION_SUMMARY',
      severity: 'INFO',
      subject:  'Top deduction categories identified',
      message:  `Top deductions found: ${topDeductions.map(([c,v]) => `${c}: $${v.toFixed(2)}`).join(', ')}`,
      action:   'Review for accuracy before including in Schedule C.',
      top_categories: topDeductions.map(([cat, total]) => ({ cat, total: parseFloat(total.toFixed(2)) })),
    });
  }

  return notifications;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY BUILDER
// ═══════════════════════════════════════════════════════════════════════════
function buildSummary(txs) {
  const income     = txs.filter(t => t.tax_category?.startsWith('INCOME'));
  const deductions = txs.filter(t => t.is_business === true && t.type === 'DEBIT');
  const flagged    = txs.filter(t => t.needs_clarification);

  const byCat = {};
  txs.forEach(t => {
    const c = t.tax_category || 'UNCATEGORIZED';
    if (!byCat[c]) byCat[c] = { count: 0, total: 0 };
    byCat[c].count++;
    byCat[c].total = parseFloat((byCat[c].total + (t.amount || 0)).toFixed(2));
  });

  const totalDeductions = deductions.reduce((s, t) => s + (t.amount || 0), 0);
  const mealsDed        = (byCat['MEALS_BUSINESS']?.total || 0) * 0.5; // 50% meals rule

  return {
    total_transactions:    txs.length,
    total_income:          parseFloat(income.reduce((s,t) => s+(t.amount||0),0).toFixed(2)),
    total_income_1099:     parseFloat(txs.filter(t=>t.tax_category==='INCOME_1099').reduce((s,t)=>s+(t.amount||0),0).toFixed(2)),
    total_deductions:      parseFloat(totalDeductions.toFixed(2)),
    meals_50pct_adjustment: parseFloat(mealsDed.toFixed(2)),
    net_deductions:        parseFloat((totalDeductions - mealsDed).toFixed(2)),
    estimated_tax_savings: parseFloat(((totalDeductions - mealsDed) * 0.28).toFixed(2)),
    flagged_for_review:    flagged.length,
    high_confidence:       txs.filter(t => t.confidence === 'HIGH').length,
    medium_confidence:     txs.filter(t => t.confidence === 'MEDIUM').length,
    low_confidence:        txs.filter(t => t.confidence === 'LOW').length,
    by_category: byCat,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL EXPORT  (multi-sheet workbook)
// ═══════════════════════════════════════════════════════════════════════════
async function buildExcel(final) {
  const wb   = new ExcelJS.Workbook();
  const fn   = `${ts()}_REPORT.xlsx`;
  const path = join(OUTPUT_DIR, fn);

  // ── COLOURS ──────────────────────────────────────────────────────────────
  const C = {
    headerBg:    '1F3864',   // dark navy
    headerFg:    'FFFFFF',
    incomeGreen: 'E2EFDA',
    deductBlue:  'DDEEFF',
    flagRed:     'FFCCCC',
    warningAmb:  'FFF2CC',
    altRow:      'F5F5F5',
    subBg:       'FFF9C4',
    bold:        true,
  };

  function hdr(ws, cols) {
    ws.columns = cols;
    const row = ws.getRow(1);
    row.font   = { bold: true, color: { argb: C.headerFg }, name: 'Arial', size: 10 };
    row.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    row.alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 20;
    row.commit();
  }

  function moneyFmt(ws, col, fromRow, toRow) {
    for (let r = fromRow; r <= toRow; r++) {
      const cell = ws.getCell(r, col);
      cell.numFmt = '$#,##0.00;($#,##0.00);"-"';
    }
  }

  // ── SHEET 1: ALL TRANSACTIONS ─────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Transactions');
  hdr(ws1, [
    { header: '#',           key: 'line_number',        width: 6  },
    { header: 'Date',        key: 'date',               width: 12 },
    { header: 'Description', key: 'description',        width: 40 },
    { header: 'Amount',      key: 'amount',             width: 14 },
    { header: 'Type',        key: 'type',               width: 8  },
    { header: 'Category',    key: 'tax_category',       width: 22 },
    { header: 'Business?',   key: 'is_business',        width: 10 },
    { header: 'Confidence',  key: 'confidence',         width: 11 },
    { header: 'Needs Review',key: 'needs_clarification',width: 12 },
    { header: 'Note',        key: 'categorization_note',width: 45 },
    { header: 'Source File', key: '_source_file',       width: 22 },
  ]);

  (final.transactions || []).forEach((t, i) => {
    const row = ws1.addRow({
      line_number:         t.line_number,
      date:                t.date,
      description:         t.description,
      amount:              t.amount,
      type:                t.type,
      tax_category:        t.tax_category    || 'UNCATEGORIZED',
      is_business:         t.is_business === true ? 'YES' : t.is_business === false ? 'NO' : '?',
      confidence:          t.confidence     || '',
      needs_clarification: t.needs_clarification ? '⚑ YES' : '',
      categorization_note: t.categorization_note || '',
      _source_file:        t._source_file   || '',
    });

    // Colour coding
    const fill = t.needs_clarification ? C.flagRed
               : t.type === 'CREDIT'   ? C.incomeGreen
               : t.is_business         ? C.deductBlue
               : i % 2 === 0           ? C.altRow : 'FFFFFF';

    row.eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.font      = { name: 'Arial', size: 9 };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'DDDDDD' } } };
    });

    // Format amount as currency
    const amountCell = row.getCell('amount');
    amountCell.numFmt = '$#,##0.00;($#,##0.00);"-"';
  });

  ws1.autoFilter = { from: 'A1', to: 'K1' };
  ws1.views = [{ state: 'frozen', ySplit: 1 }];

  // ── SHEET 2: INCOME ───────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Income');
  hdr(ws2, [
    { header: 'Date',    key: 'date',        width: 12 },
    { header: 'Payer',   key: 'description', width: 40 },
    { header: 'Amount',  key: 'amount',      width: 14 },
    { header: 'Type',    key: 'tax_category',width: 18 },
    { header: 'Source',  key: '_source_file',width: 22 },
  ]);

  const incomes = (final.transactions || []).filter(t => t.tax_category?.startsWith('INCOME'));
  incomes.forEach(t => {
    const row = ws2.addRow({ date: t.date, description: t.description, amount: t.amount, tax_category: t.tax_category, _source_file: t._source_file });
    row.getCell('amount').numFmt = '$#,##0.00';
    row.getCell('amount').fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.incomeGreen } };
  });

  const incomeTotalRow = ws2.addRow({ description: 'TOTAL INCOME', amount: { formula: `SUM(C2:C${incomes.length+1})` } });
  incomeTotalRow.font = { bold: true, name: 'Arial' };
  incomeTotalRow.getCell('amount').numFmt = '$#,##0.00';

  // ── SHEET 3: DEDUCTIONS ───────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Deductions');
  hdr(ws3, [
    { header: 'Date',     key: 'date',               width: 12 },
    { header: 'Payee',    key: 'description',        width: 40 },
    { header: 'Amount',   key: 'amount',             width: 14 },
    { header: 'Category', key: 'tax_category',       width: 22 },
    { header: 'Conf.',    key: 'confidence',         width: 8  },
    { header: 'Note',     key: 'categorization_note',width: 40 },
    { header: 'Source',   key: '_source_file',       width: 22 },
  ]);

  const deductions = (final.transactions || []).filter(t => t.is_business === true && t.type === 'DEBIT');
  deductions.forEach(t => {
    const row = ws3.addRow({ date: t.date, description: t.description, amount: t.amount, tax_category: t.tax_category, confidence: t.confidence, categorization_note: t.categorization_note, _source_file: t._source_file });
    row.getCell('amount').numFmt = '$#,##0.00';
    if (t.tax_category === 'MEALS_BUSINESS') {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.warningAmb } }; });
    } else {
      row.getCell('amount').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.deductBlue } };
    }
  });

  const dedTotalRow = ws3.addRow({ description: 'TOTAL DEDUCTIONS', amount: { formula: `SUM(C2:C${deductions.length+1})` } });
  dedTotalRow.font = { bold: true, name: 'Arial' };
  dedTotalRow.getCell('amount').numFmt = '$#,##0.00';

  // ── SHEET 4: SUBCONTRACTORS & 1099-NEC ───────────────────────────────────
  const ws4 = wb.addWorksheet('1099-NEC');
  hdr(ws4, [
    { header: 'Name',         key: 'name',       width: 30 },
    { header: 'Total Paid',   key: 'total',      width: 14 },
    { header: 'Threshold Met',key: 'threshold',  width: 14 },
    { header: 'Dates',        key: 'dates',      width: 40 },
    { header: 'Action',       key: 'action',     width: 50 },
  ]);

  const subcNotifs = (final.notifications || []).filter(n => n.type === '1099_NEC_CANDIDATE');
  subcNotifs.forEach(n => {
    const row = ws4.addRow({
      name:      n.subject.replace('Subcontractor: ',''),
      total:     n.total_paid,
      threshold: n.threshold_met ? '⚠️  YES — FILE' : 'Not yet',
      dates:     n.transactions?.map(t => t.date).join(', ') || '',
      action:    n.action,
    });
    row.getCell('total').numFmt = '$#,##0.00';
    if (n.threshold_met) {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.flagRed } }; });
    } else {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subBg } }; });
    }
  });

  // ── SHEET 5: QUESTIONNAIRE ───────────────────────────────────────────────
  const ws5 = wb.addWorksheet('Client Questions');
  hdr(ws5, [
    { header: '#',          key: 'num',        width: 5  },
    { header: 'Question',   key: 'question',   width: 70 },
    { header: 'Suggested',  key: 'hint',       width: 40 },
    { header: 'Category',   key: 'category',   width: 22 },
    { header: 'Amount',     key: 'total',      width: 14 },
    { header: 'Client Answer', key: 'answer',  width: 40 },
  ]);

  (final.client_questions || []).forEach((q, i) => {
    const row = ws5.addRow({
      num:      i + 1,
      question: q.question,
      hint:     q.hint || '',
      category: q.tax_category,
      total:    q.total_amount,
      answer:   '',
    });
    row.getCell('total').numFmt  = '$#,##0.00';
    row.getCell('answer').fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7' } };
    row.getCell('question').alignment = { wrapText: true };
    row.height = 35;
    if (i % 2 === 0) {
      row.eachCell(c => {
        if (!c.value && c.col !== ws5.getColumn('answer').number)
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
      });
    }
  });

  // ── SHEET 6: SUMMARY DASHBOARD ───────────────────────────────────────────
  const ws6 = wb.addWorksheet('Summary');
  ws6.columns = [{ width: 35 }, { width: 20 }];

  const s = final.summary;
  const addSummaryRow = (label, value, bold = false, money = false) => {
    const row = ws6.addRow([label, value]);
    if (bold) row.font = { bold: true, name: 'Arial', size: 11 };
    else       row.font = { name: 'Arial', size: 10 };
    if (money) row.getCell(2).numFmt = '$#,##0.00';
    return row;
  };

  ws6.addRow(['TAXPREP PRO — ANALYSIS SUMMARY']).font = { bold: true, size: 14, color: { argb: C.headerBg } };
  ws6.addRow([`Generated: ${new Date().toLocaleString()}`]).font = { italic: true, size: 9 };
  ws6.addRow([]);
  addSummaryRow('Total Transactions',          s.total_transactions);
  ws6.addRow([]);
  addSummaryRow('INCOME', '', true);
  addSummaryRow('  Total 1099 Income',         s.total_income_1099, false, true);
  addSummaryRow('  Total Other Income',        s.total_income - s.total_income_1099, false, true);
  addSummaryRow('  TOTAL INCOME',              s.total_income, true, true);
  ws6.addRow([]);
  addSummaryRow('DEDUCTIONS (Schedule C)', '', true);
  addSummaryRow('  Gross Deductions',          s.total_deductions, false, true);
  addSummaryRow('  Meals Adjustment (50%)',    -s.meals_50pct_adjustment, false, true);
  addSummaryRow('  NET DEDUCTIONS',            s.net_deductions, true, true);
  ws6.addRow([]);
  addSummaryRow('Est. Tax Savings (@ 28%)',    s.estimated_tax_savings, true, true);
  ws6.addRow([]);
  addSummaryRow('REVIEW FLAGS', '', true);
  addSummaryRow('  Items Needing Clarification', s.flagged_for_review);
  addSummaryRow('  HIGH confidence',           s.high_confidence);
  addSummaryRow('  MEDIUM confidence',         s.medium_confidence);
  addSummaryRow('  LOW confidence',            s.low_confidence);
  ws6.addRow([]);
  addSummaryRow('CATEGORY BREAKDOWN', '', true);
  Object.entries(s.by_category).sort(([,a],[,b]) => b.total - a.total).forEach(([cat, v]) => {
    const row = ws6.addRow([`  ${cat}`, v.total]);
    row.getCell(2).numFmt = '$#,##0.00;($#,##0.00);"-"';
    row.font = { name: 'Arial', size: 9 };
  });

  await wb.xlsx.writeFile(path);
  console.log(`  📊 Excel saved → output/${fn}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE STATEMENT PROCESSOR
// Runs Agent 1 → Agent 2 → retry loop
// ═══════════════════════════════════════════════════════════════════════════
async function processStatement(pdfPath) {
  let ext = null;
  let corrections = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    ext         = await agent1_extract(pdfPath, corrections, attempt);
    const label = basename(pdfPath).slice(0, 20);
    const { approved, correctionPrompt } = agent2_judge(ext, label);

    if (approved) break;

    if (attempt < MAX_RETRIES) {
      console.log(`\n  ↩️  Sending corrections to Agent 1 (attempt ${attempt + 1})...`);
      corrections = correctionPrompt;
    } else {
      console.log('\n  ⚠️  Max retries reached — proceeding with best available result');
      ext._math_warning = `Statement did not fully reconcile after ${MAX_RETRIES} attempts.`;
    }
  }

  return ext;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          TAXPREP PRO — MULTI-AGENT PIPELINE  v3.0           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  📂 ${PDF_PATHS.length} statement(s):`);
  PDF_PATHS.forEach((p, i) => console.log(`     ${i+1}. ${basename(p)}`));
  console.log(`  🕐 Started: ${new Date().toLocaleString()}`);
  console.log(`  🤖 Pro model:   ${MODEL_PRO}  (thinking: high)`);
  console.log(`  ⚡ Flash model: ${MODEL_FLASH} (Google Search enabled)\n`);

  // ── Process each PDF in order ─────────────────────────────────────────────
  const allExtractions = [];

  for (let i = 0; i < PDF_PATHS.length; i++) {
    console.log(`\n${'━'.repeat(65)}`);
    console.log(`  STATEMENT ${i+1}/${PDF_PATHS.length}: ${basename(PDF_PATHS[i])}`);
    console.log(`${'━'.repeat(65)}`);
    allExtractions.push(await processStatement(PDF_PATHS[i]));
  }

  // ── Merge all statements ──────────────────────────────────────────────────
  let globalLine = 1;
  const mergedTxs = [];

  allExtractions.forEach(ext => {
    (ext.transactions || []).forEach(t => {
      mergedTxs.push({
        ...t,
        _source_file:         ext._meta?.source_file || 'unknown',
        _global_line_number:  globalLine++,
      });
    });
  });

  const mergedExt = {
    account_holder_name: allExtractions[0]?.account_holder_name || 'Unknown',
    bank_name:           allExtractions[0]?.bank_name           || 'Unknown',
    statements: allExtractions.map(e => ({
      source_file:   e._meta?.source_file,
      period_start:  e.statement_period_start,
      period_end:    e.statement_period_end,
      opening:       e.opening_balance,
      closing:       e.closing_balance,
      count:         e.transactions?.length ?? 0,
      math_warning:  e._math_warning || null,
    })),
    transactions:  mergedTxs,
    _source_files: allExtractions.map(e => e._meta?.source_file),
  };

  // ── Agent 3 categorises everything ────────────────────────────────────────
  const final = await agent3_categorize(mergedExt);
  const s     = final.summary;

  // ── FINAL REPORT ──────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                     PIPELINE COMPLETE                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  Account:            ${final.account_holder_name}`);
  final.statements?.forEach((st, i) =>
    console.log(`  Statement ${i+1}:         ${st.period_start} → ${st.period_end}  (${st.count} tx${st.math_warning ? '  ⚠️  '+st.math_warning : ''})`)
  );
  console.log(`\n  Transactions:       ${s.total_transactions}`);
  console.log(`  1099 Income:        $${s.total_income_1099}`);
  console.log(`  Total Income:       $${s.total_income}`);
  console.log(`  Gross Deductions:   $${s.total_deductions}`);
  console.log(`  Net Deductions:     $${s.net_deductions}  (after 50% meals adjustment)`);
  console.log(`  Est. Tax Savings:   $${s.estimated_tax_savings}  (@ 28%)`);
  console.log(`  Need Review:        ${s.flagged_for_review} items`);
  console.log(`  Client Questions:   ${final.client_questions?.length ?? 0} generated`);
  console.log(`  Notifications:      ${final.notifications?.length ?? 0} generated`);

  tok.print();

  console.log(`\n  📁 Output files in: ./output/`);
  console.log(`      *.json               → Raw data for API integration`);
  console.log(`      *_REPORT.xlsx        → Excel workbook (6 sheets)`);
  console.log(`      *_QUESTIONNAIRE.json → Client questions`);
  console.log(`      *_NOTIFICATIONS.json → Email flags`);
  console.log(`\n  🏁 Finished: ${new Date().toLocaleString()}\n`);
}

main().catch(err => {
  console.error('\n💥 Pipeline crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});