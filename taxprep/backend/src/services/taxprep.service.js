// taxprep_pipeline.js  v4.1
// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURE:
//   Agent 1 — EXTRACTOR      gemini-3.1-pro-preview  (thinking: low)
//             Line-by-line extraction, anchor chain math, 3 retries
//             Retry wrapper: 3 attempts, 3s/8s/20s backoff, 5min timeout
//
//   Agent 2 — JUDGE          Pure JS — no AI call
//             Anchor chain validation, coherence check, correction prompt
//
//   Agent 3 — CATEGORISER    gemini-3.1-pro-preview  (no thinking + Google Search)
//             Runs PER STATEMENT immediately after extract+judge — not batched
//             Length validation: if returned array < input, rejects and retries
//             Pattern cache feeds forward — Jan merchants known by Feb
//             resolveQuestionnaire() for answered questions
//
// FLOW (per PDF — one at a time):
//   Extract → Judge → Categorise → learn cache → next PDF
//   After all PDFs: detectInterAccountTransfers → merge → Excel
//
// USAGE:
//   node taxprep_pipeline.js "jan.pdf" "feb.pdf"
//   node taxprep_pipeline.js "jan.pdf" "feb.pdf" --context client.json
//
// OUTPUT (./output/):
//   <ts>_attempt1_extract.json       (per statement)
//   <ts>_judge_verdict.json          (per statement)
//   <ts>_categorized_<month>.json    (per statement)
//   <ts>_categorized_FINAL.json      (all merged)
//   <ts>_QUESTIONNAIRE.json
//   <ts>_NOTIFICATIONS.json
//   <ts>_REPORT.xlsx
//   pattern_cache.json               ← persistent across runs
// ═══════════════════════════════════════════════════════════════════════════

import { GoogleGenAI } from '@google/genai';
import {
  readFileSync, writeFileSync,
  mkdirSync, existsSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const CACHE_FILE = join(__dirname, 'pattern_cache.json');
mkdirSync(OUTPUT_DIR, { recursive: true });

const MODEL_PRO = 'gemini-3.1-pro-preview';
const MODEL_CAT = 'gemini-3.1-pro-preview';

const MAX_RETRIES = 3;
const MATH_TOLERANCE = 0.05;
const AGENT_TIMEOUT_MS = 300000;
const RETRY_DELAYS = [3000, 8000, 20000];
const STMT_DELAY_MS = 15000;

const args = process.argv.slice(2);
const ctxFlag = args.indexOf('--context');
const PDF_PATHS = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--context'
);

let CLIENT_CONTEXT = null;
if (ctxFlag !== -1 && args[ctxFlag + 1]) {
  try {
    const raw = readFileSync(args[ctxFlag + 1], 'utf8').trim();
    CLIENT_CONTEXT = raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn(`  ⚠️  Could not read context file: ${e.message} — continuing without context`);
  }
}

if (PDF_PATHS.length === 0) {
  console.error('\n  Usage: node taxprep_pipeline.js "file.pdf" [--context client.json]\n');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('\n  ERROR: GEMINI_API_KEY not set in .env\n');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const patternCache = new Map();

function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      Object.entries(data).forEach(([k, v]) => patternCache.set(k, v));
      console.log(`  🧠 Pattern cache loaded: ${patternCache.size} known merchants`);
    } catch { }
  }
}

function saveCache() {
  try {
    const obj = Object.fromEntries(patternCache);
    writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch { }
}

function learnPatterns(txs) {
  txs.forEach(t => {
    if (!t.tax_category || t.tax_category.startsWith('UNCLEAR') ||
      t.tax_category.startsWith('MEALS')) return;
    const key = (t.description || '').slice(0, 20).toLowerCase().trim();
    if (key.length > 3) {
      patternCache.set(key, {
        tax_category: t.tax_category,
        is_business: t.is_business,
        confidence: t.confidence,
      });
    }
  });
  saveCache();
  console.log(`  🧠 Pattern cache updated: ${patternCache.size} merchants`);
}

function buildCacheContext() {
  if (patternCache.size === 0) return '';
  const entries = [...patternCache.entries()]
    .slice(0, 80)
    .map(([k, v]) => `  "${k}" → ${v.tax_category} (${v.confidence}, biz:${v.is_business})`)
    .join('\n');
  return `\nKNOWN MERCHANTS FROM PRIOR MONTHS — use these as starting point but still verify:\n${entries}\n`;
}

const INDUSTRY_MODULES = {
  property_preservation: {
    label: 'Property Preservation Contractor',
    income_identifiers: [
      'Safeguard Properties', 'MCS', 'Cyprexx', 'Five Brothers', 'Altisource',
      'FAS', 'VRM', 'Assurant', 'CWIS', 'Berghorst', 'Chronos', 'Servicelink',
      'Nationstar', 'Northsight', 'Greenfield', 'Mortgage Connect', 'MORTGAGE CON',
      'NORTHSIGHT MGM',
    ],
    known_suppliers: [
      'Home Depot', 'Lowes', 'Menards', 'Ace Hardware', 'True Value', '84 Lumber',
      'Fastenal', 'Grainger', 'Harbor Freight',
    ],
    special_rules: [
      'Large Zelle/Venmo/CashApp DEBITS to individuals are likely subcontractor labor',
      'Multi-line ACH entries from mortgage/property companies are income_1099',
      'Dump fees and disposal are deductible as job_supplies',
    ],
  },
  general_trades: {
    label: 'General Trades (Plumber / Electrician / HVAC / Roofer)',
    income_identifiers: [
      'Homeowner payments via Zelle/check/transfer', 'Invoice payments',
      'Square', 'Stripe', 'PayPal Business',
    ],
    known_suppliers: [
      'Ferguson', 'Hajoca', 'Grainger', 'Fastenal', 'Home Depot', 'Lowes',
      'NAPA', 'AutoZone', 'Electrical supply', 'Plumbing supply',
    ],
    special_rules: [
      'Parts purchased for specific jobs are job_supplies (COGS-adjacent)',
      'Permit fees are deductible as licensing',
      'Tool purchases under $2500 are tools_equipment, over $2500 flag for depreciation',
    ],
  },
  lawn_care: {
    label: 'Lawn Care / Landscaping',
    income_identifiers: [
      'Homeowner payments', 'Zelle from clients', 'Check deposits', 'Square', 'Stripe',
    ],
    known_suppliers: [
      'Home Depot', 'Lowes', 'SiteOne Landscape', 'John Deere', 'Husqvarna',
      'NAPA', 'AutoZone', 'Fuel stations',
    ],
    special_rules: [
      'Mulch, seed, fertiliser, plants are job_supplies',
      'Trailer payments may be vehicle_payment — ask client',
      'Mower repair is vehicle_repair equivalent — tools_equipment',
    ],
  },
  rideshare_delivery: {
    label: 'Rideshare / Delivery (Uber / Lyft / DoorDash / Instacart)',
    income_identifiers: [
      'Uber', 'Lyft', 'DoorDash', 'Instacart', 'Amazon Flex',
      'Grubhub', 'Shipt', 'Postmates',
    ],
    known_suppliers: [
      'Shell', 'BP', 'Chevron', 'Exxon', 'Circle K', 'QT', 'Wawa', 'Speedway',
      'AutoZone', 'OReilly', 'Jiffy Lube', 'Firestone',
    ],
    special_rules: [
      'Weekly platform deposits are income_1099 equivalent — use income_other',
      'Phone mount, insulated bags, dash cam are tools_equipment',
      'Car wash may be vehicle_repair if used for rideshare — ask client',
    ],
  },
  freelancer_creative: {
    label: 'Freelancer / Creative (Designer / Developer / Writer)',
    income_identifiers: [
      'Stripe', 'PayPal', 'Wise', 'Payoneer', 'Direct transfer from client',
      'Upwork', 'Fiverr', 'Toptal',
    ],
    known_suppliers: [
      'Adobe', 'Figma', 'Notion', 'Canva', 'Google Workspace', 'Microsoft 365',
      'GitHub', 'Netlify', 'Vercel', 'AWS', 'DigitalOcean', 'Zoom', 'Slack',
    ],
    special_rules: [
      'Home office deduction cannot be detected from bank statement — flag note',
      'Software subscriptions are software category',
      'Coworking space rent is rent_storage',
      'Equipment like monitor, keyboard, laptop — flag for depreciation if over $2500',
    ],
  },
  cleaning_services: {
    label: 'Cleaning Services (Residential / Commercial)',
    income_identifiers: [
      'Client payments via Zelle/check/transfer', 'Square', 'Stripe',
    ],
    known_suppliers: [
      'Costco', 'Sams Club', 'Dollar General', 'Walmart', 'Procter and Gamble',
      'Zep', 'Diversey', 'Cintas', 'janitorial supply',
    ],
    special_rules: [
      'Cleaning supplies are job_supplies',
      'Uniform/apron purchases are uniforms category',
      'Vehicle use for travel between jobs — fuel is fully deductible',
    ],
  },
  beauty_personal_care: {
    label: 'Beauty / Personal Care (Hair / Nails / Barber / Esthetician)',
    income_identifiers: [
      'Client payments', 'Square', 'Stripe', 'Venmo Business', 'Cash App Business',
    ],
    known_suppliers: [
      'Sally Beauty', 'CosmoProf', 'Ulta', 'BSG', 'Armstrong McCall',
      'Babyliss', 'Wahl', 'OPI', 'Gelish',
    ],
    special_rules: [
      'Booth rent is rent_storage — highly deductible, flag separately',
      'Product supplies are job_supplies',
      'Styling tools are tools_equipment',
      'Cash income is common — flag large cash deposits for income reporting',
    ],
  },
  retail_ecommerce: {
    label: 'Retail / Ecommerce (Shopify / Etsy / Amazon Seller)',
    income_identifiers: [
      'Shopify', 'Etsy', 'Amazon Seller', 'eBay', 'PayPal', 'Stripe',
      'Square', 'Printful', 'Printify',
    ],
    known_suppliers: [
      'Alibaba', 'AliExpress', 'Wholesale supplier', 'Printful', 'Printify',
      'USPS', 'FedEx', 'UPS', 'Packaging supplier',
    ],
    special_rules: [
      'COGS REQUIRED: product purchases are cogs_inventory not job_supplies',
      'Bank deposits are NET revenue after platform fees — note this',
      'Shipping costs paid are shipping category',
      'Platform fees (Shopify monthly, Etsy listing) are software/professional_fees',
      'FLAG: COGS must be reconciled from inventory records — bank statement alone is insufficient for retail',
    ],
  },
  general_self_employed: {
    label: 'General Self-Employed',
    income_identifiers: [
      'Direct client payment', 'Zelle from client', 'Check deposit', 'Square', 'Stripe', 'PayPal',
    ],
    known_suppliers: [],
    special_rules: [
      'Use broad reasoning — this is a catch-all industry',
      'Flag more items for clarification than usual — less context available',
    ],
  },
};

function buildIndustryContext(ctx) {
  const industries = ctx?.industries?.length ? ctx.industries : ['general_self_employed'];
  const modules = industries.map(i => INDUSTRY_MODULES[i]).filter(Boolean);

  if (ctx?.industry_description) {
    modules.push({
      label: 'Custom (Other)',
      income_identifiers: [],
      known_suppliers: [],
      special_rules: [`Client described their work as: "${ctx.industry_description}". Use this to reason about categories.`],
    });
  }

  const lines = ['INDUSTRY CONTEXT:'];
  modules.forEach(m => {
    lines.push(`\n[${m.label}]`);
    if (m.income_identifiers.length)
      lines.push(`  Income sources: ${m.income_identifiers.join(', ')}`);
    if (m.known_suppliers.length)
      lines.push(`  Known suppliers (deductible): ${m.known_suppliers.join(', ')}`);
    m.special_rules.forEach(r => lines.push(`  Rule: ${r}`));
  });

  return lines.join('\n');
}

function buildClientContext(ctx) {
  if (!ctx) return 'No client context provided — use your best judgment and Google Search for unknowns.';

  const lines = [];

  if (ctx.known_people?.length) {
    lines.push('KNOWN PEOPLE IN TRANSACTIONS:');
    ctx.known_people.forEach(p => {
      lines.push(`  - ${p.name.toUpperCase()} → ${p.role}${p.note ? ' (' + p.note + ')' : ''}`);
    });
    lines.push('NOTE: Even where a person is identified, still verify amounts, still document,');
    lines.push('still ask if anything seems unusual — client context informs reasoning, does not replace verification.');
  }

  if (ctx.meals) {
    lines.push('\nMEALS CONTEXT:');
    if (ctx.meals.business_contacts)
      lines.push(`  Business meals typically with: ${ctx.meals.business_contacts}`);
    if (ctx.meals.business_restaurants?.length)
      lines.push(`  Known business restaurants: ${ctx.meals.business_restaurants.join(', ')}`);
    if (ctx.meals.personal_restaurants?.length)
      lines.push(`  Known personal restaurants: ${ctx.meals.personal_restaurants.join(', ')}`);
    lines.push('  ALWAYS flag meal transactions for clarification — ask who attended and business purpose.');
    lines.push('  Use MEALS_BUSINESS_CONFIRMED only after client documents who they ate with.');
    lines.push('  Use MEALS_PERSONAL for known personal restaurants.');
    lines.push('  Use MEALS_UNCONFIRMED for everything else.');
  }

  if (ctx.phone_business_pct)
    lines.push(`\nPHONE: Client stated ${ctx.phone_business_pct}% business use — note proration in categorization_note`);

  if (ctx.internet_business_pct)
    lines.push(`INTERNET: Client stated ${ctx.internet_business_pct}% business use — note proration`);

  if (ctx.known_business_recurring?.length)
    lines.push(`\nKNOWN BUSINESS SUBSCRIPTIONS: ${ctx.known_business_recurring.join(', ')}`);

  if (ctx.known_personal_recurring?.length)
    lines.push(`KNOWN PERSONAL SUBSCRIPTIONS (not deductible): ${ctx.known_personal_recurring.join(', ')}`);

  if (ctx.unusual_notes)
    lines.push(`\nCLIENT NOTES (use these to inform categorisation): ${ctx.unusual_notes}`);

  return lines.join('\n');
}

const tok = {
  pro_thinking: { calls: [], input: 0, output: 0, thinking: 0 },
  pro_standard: { calls: [], input: 0, output: 0 },

  record(isThinking, label, meta) {
    if (!meta) return;
    const i = meta.promptTokenCount || 0;
    const o = meta.candidatesTokenCount || 0;
    const t = meta.thoughtsTokenCount || 0;
    if (isThinking) {
      this.pro_thinking.calls.push({ label, input: i, output: o, thinking: t });
      this.pro_thinking.input += i;
      this.pro_thinking.output += o;
      this.pro_thinking.thinking += t;
    } else {
      this.pro_standard.calls.push({ label, input: i, output: o });
      this.pro_standard.input += i;
      this.pro_standard.output += o;
    }
  },

  print() {
    const p = (s, n) => String(s).padEnd(n);
    const rp = (s, n) => String(s).padStart(n);
    console.log('\n  ┌────────────────────────────────────────────────────────────────────┐');
    console.log('  │                      TOKEN USAGE SUMMARY                           │');
    console.log('  ├────────────────────────────────┬─────────┬────────┬────────┬───────┤');
    console.log('  │ Call                           │  Input  │ Output │Thinking│ Total │');
    console.log('  ├────────────────────────────────┼─────────┼────────┼────────┼───────┤');
    console.log('  │ ── 3.1 PRO WITH THINKING ──    │         │        │        │       │');
    this.pro_thinking.calls.forEach(c => {
      const tot = c.input + c.output + c.thinking;
      console.log(`  │ ${p(c.label, 30)}   │${rp(c.input, 7)}  │${rp(c.output, 7)} │${rp(c.thinking, 7)} │${rp(tot, 6)} │`);
    });
    const pt = this.pro_thinking.input + this.pro_thinking.output + this.pro_thinking.thinking;
    console.log(`  │ ${p('PRO THINKING SUBTOTAL', 30)}   │${rp(this.pro_thinking.input, 7)}  │${rp(this.pro_thinking.output, 7)} │${rp(this.pro_thinking.thinking, 7)} │${rp(pt, 6)} │`);
    console.log('  ├────────────────────────────────┼─────────┼────────┼────────┼───────┤');
    console.log('  │ ── 3.1 PRO NO THINKING ──      │         │        │        │       │');
    this.pro_standard.calls.forEach(c => {
      const tot = c.input + c.output;
      console.log(`  │ ${p(c.label, 30)}   │${rp(c.input, 7)}  │${rp(c.output, 7)} │${rp('-', 7)} │${rp(tot, 6)} │`);
    });
    const st = this.pro_standard.input + this.pro_standard.output;
    console.log(`  │ ${p('PRO STANDARD SUBTOTAL', 30)}   │${rp(this.pro_standard.input, 7)}  │${rp(this.pro_standard.output, 7)} │${rp('-', 7)} │${rp(st, 6)} │`);
    console.log('  ├────────────────────────────────┼─────────┼────────┼────────┼───────┤');
    console.log(`  │ ${p('GRAND TOTAL', 30)}   │         │        │        │${rp(pt + st, 6)} │`);
    console.log('  └────────────────────────────────┴─────────┴────────┴────────┴───────┘');
  },
};

function ts() {
  return new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
}
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
function sanitize(ext) {
  ext.opening_balance = toFloat(ext.opening_balance);
  ext.closing_balance = toFloat(ext.closing_balance);
  (ext.transactions || []).forEach(t => {
    t.amount = toFloat(t.amount);
    t.running_balance = toFloat(t.running_balance);
    t.type = (t.type || '').toUpperCase();
    if (!['DEBIT', 'CREDIT'].includes(t.type)) t.type = 'DEBIT';
  });
  return ext;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callWithRetry(fn, label) {
  for (let i = 0; i < RETRY_DELAYS.length + 1; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Timed out after 2 minutes')), AGENT_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      const isLast = i === RETRY_DELAYS.length;
      console.log(`  ⚠️  ${label} attempt ${i + 1} failed: ${err.message}`);
      if (isLast) throw err;
      console.log(`  ⏳ Waiting ${RETRY_DELAYS[i] / 1000}s before retry...`);
      await sleep(RETRY_DELAYS[i]);
    }
  }
}

async function agent1_extract(pdfPath, correctionPrompt = null, attempt = 1) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 1 — EXTRACTOR  [${MODEL_PRO} + thinking]  attempt ${attempt}/${MAX_RETRIES}`);
  console.log(`${'═'.repeat(65)}`);

  const pdfBase64 = readFileSync(pdfPath).toString('base64');

  let prompt = `You are a precise bank statement extraction specialist.

Extract EVERY transaction line by line in the EXACT ORDER they appear.

═══ ANCHOR CHAIN — CRITICAL ═══
Every transaction MUST include running_balance = balance after that transaction.
If shown in PDF: use it exactly.
If not shown: calculate it.
  CREDIT: running_balance[n] = running_balance[n-1] + amount
  DEBIT:  running_balance[n] = running_balance[n-1] - amount
Starting value = opening_balance.
This chain proves every transaction was captured.

═══ RULES ═══
1. Extract EVERYTHING — fees, reversals, transfers, interest, ATM, ACH, wire, NSF
2. Exact document order — never reorder
3. EXACT description text — do not clean, abbreviate, or interpret
4. Amounts always POSITIVE. type = DEBIT or CREDIT
5. Multi-line entries: combine into one, raw_line = full original text
   PP payments often span 2-3 lines — combine all lines into one entry
6. Dates: YYYY-MM-DD. Missing date: inherit nearest date above
7. line_number sequential from 1. page_number = PDF page

Return ONLY valid JSON:
{
  "account_holder_name":"","account_number_last4":"","account_type":"CHECKING",
  "bank_name":"","statement_period_start":"YYYY-MM-DD","statement_period_end":"YYYY-MM-DD",
  "opening_balance":0.00,"closing_balance":0.00,"currency":"USD",
  "transactions":[{
    "line_number":1,"page_number":1,"date":"YYYY-MM-DD",
    "description":"EXACT TEXT","amount":0.00,"type":"DEBIT or CREDIT",
    "running_balance":0.00,"raw_line":"full original line"
  }],
  "transaction_count":0,"total_credits":0.00,"total_debits":0.00,
  "extraction_notes":""
}`;

  if (correctionPrompt) {
    prompt += `\n\n${'═'.repeat(55)}\n⚠️  JUDGE CORRECTIONS — FIX ALL:\n${'═'.repeat(55)}\n${correctionPrompt}\n\nReturn COMPLETE corrected JSON.`;
  }

  console.log(`  📄 Sending PDF to ${MODEL_PRO}...`);

  const response = await callWithRetry(() =>
    ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
        ],
      }],
      config: {
        temperature: 0.1,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    }),
    `Agent1 attempt${attempt}`
  );

  tok.record(true, `Agent1 attempt${attempt}`, response.usageMetadata);

  let ext;
  try {
    ext = JSON.parse(cleanJSON(response.text));
  } catch (e) {
    saveJSON({ raw: response.text, error: e.message }, `attempt${attempt}_PARSE_FAILED`);
    throw new Error(`Agent 1 JSON parse failed: ${e.message}`);
  }

  ext = sanitize(ext);
  ext._meta = {
    attempt,
    extracted_at: new Date().toISOString(),
    source_file: basename(pdfPath),
    model: MODEL_PRO,
    had_corrections: !!correctionPrompt,
  };

  saveJSON(ext, `attempt${attempt}_extract`);
  console.log(`  ✅ ${ext.transactions?.length ?? 0} transactions  |  ${ext.statement_period_start} → ${ext.statement_period_end}`);
  console.log(`     Opening: $${ext.opening_balance}  →  Closing: $${ext.closing_balance}`);
  return ext;
}

function agent2_judge(ext, fileLabel = '') {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 2 — JUDGE  [Pure JS]${fileLabel ? '  ' + fileLabel : ''}`);
  console.log(`${'═'.repeat(65)}`);

  const issues = [];
  const warnings = [];
  const txs = ext.transactions || [];

  if (ext.opening_balance != null && txs.length > 0) {
    let expected = toFloat(ext.opening_balance);
    let breaks = 0;

    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      expected = tx.type === 'CREDIT'
        ? parseFloat((expected + tx.amount).toFixed(2))
        : parseFloat((expected - tx.amount).toFixed(2));

      const stated = toFloat(tx.running_balance);
      const diff = Math.abs(expected - stated);

      if (stated !== 0 && diff > MATH_TOLERANCE) {
        breaks++;
        issues.push({
          severity: 'CRITICAL',
          type: 'ANCHOR_CHAIN_BREAK',
          message: `Chain broke at line ${tx.line_number}: expected $${expected} got $${stated} (diff $${diff.toFixed(2)})`,
          detail: `Re-read section between line ${i > 0 ? txs[i - 1].line_number : 'start'} and line ${tx.line_number}`,
          line_number: tx.line_number,
        });
        expected = stated;
      }
    }

    if (breaks === 0 && ext.closing_balance != null) {
      const cdiff = Math.abs(expected - toFloat(ext.closing_balance));
      if (cdiff > MATH_TOLERANCE) {
        issues.push({
          severity: 'CRITICAL',
          type: 'CLOSING_MISMATCH',
          message: `Closing: calculated $${expected} vs stated $${ext.closing_balance} (diff $${cdiff.toFixed(2)})`,
          detail: 'All running balances consistent but final total is off — missing transaction near end',
        });
      } else {
        console.log(`  ✅ Anchor chain OK — all ${txs.length} running balances verified`);
      }
    }
  }

  if (txs.length === 0)
    issues.push({ severity: 'CRITICAL', type: 'EMPTY', message: 'No transactions extracted' });

  txs.forEach(tx => {
    if (!tx.amount || tx.amount <= 0)
      issues.push({ severity: 'HIGH', type: 'INVALID_AMOUNT', message: `Line ${tx.line_number}: zero/missing amount — "${tx.description}"` });
    if (!tx.date)
      issues.push({ severity: 'HIGH', type: 'MISSING_DATE', message: `Line ${tx.line_number}: missing date — "${tx.description}"` });
    if (!['DEBIT', 'CREDIT'].includes(tx.type))
      issues.push({ severity: 'HIGH', type: 'INVALID_TYPE', message: `Line ${tx.line_number}: bad type "${tx.type}"` });
  });

  const seen = {};
  txs.forEach(tx => {
    const k = `${tx.date}_${tx.amount}_${(tx.description || '').slice(0, 15).toLowerCase()}`;
    if (seen[k] != null) warnings.push(`Possible duplicate: lines ${seen[k]} and ${tx.line_number} — "${tx.description}" $${tx.amount}`);
    else seen[k] = tx.line_number;
  });

  const critical = issues.filter(i => i.severity === 'CRITICAL');
  const high = issues.filter(i => i.severity === 'HIGH');
  const approved = critical.length === 0 && high.length === 0;

  console.log(`\n  📋 CHECKS:`);
  console.log(`     Transactions: ${txs.length}  |  Critical: ${critical.length}  |  High: ${high.length}  |  Warnings: ${warnings.length}`);
  console.log(approved ? '\n  ✅ APPROVED' : '\n  ❌ REJECTED');
  issues.forEach(i => console.log(`     [${i.severity}] ${i.message}`));
  warnings.forEach(w => console.log(`  ⚠️   ${w}`));

  const credits = txs.filter(t => t.type === 'CREDIT').reduce((s, t) => s + t.amount, 0);
  const debits = txs.filter(t => t.type === 'DEBIT').reduce((s, t) => s + t.amount, 0);

  saveJSON({
    approved, issues, warnings,
    stats: { count: txs.length, credits: credits.toFixed(2), debits: debits.toFixed(2) },
  }, `judge_verdict${fileLabel ? '_' + fileLabel.replace(/\W/g, '_') : ''}`);

  let correctionPrompt = null;
  if (!approved) {
    const lines = [`${issues.length} problem(s) to fix:\n`];
    issues.forEach((issue, i) => {
      lines.push(`${i + 1}. [${issue.severity}] ${issue.message}`);
      if (issue.detail) lines.push(`   → ${issue.detail}`);
    });
    if (warnings.length) {
      lines.push('\nAlso review:');
      warnings.forEach(w => lines.push(`- ${w}`));
    }
    lines.push('\nReturn COMPLETE corrected JSON with ALL transactions.');
    correctionPrompt = lines.join('\n');
  }

  return { approved, correctionPrompt };
}

function coherenceCheck(txs) {
  const EXPENSE_ONLY_CATS = [
    'FUEL', 'VEHICLE_REPAIR', 'VEHICLE_INSURANCE', 'VEHICLE_PAYMENT',
    'PARKING_TOLLS', 'TOOLS_EQUIPMENT', 'EQUIPMENT_RENTAL', 'JOB_SUPPLIES',
    'SAFETY_GEAR', 'UNIFORMS', 'PHONE', 'INTERNET', 'SOFTWARE', 'OFFICE_SUPPLIES',
    'SHIPPING', 'SUBCONTRACTOR', 'PROFESSIONAL_FEES', 'INSURANCE_BUSINESS',
    'LICENSING', 'MEALS_BUSINESS_CONFIRMED', 'MEALS_UNCONFIRMED',
    'BANKING_FEE', 'COGS_INVENTORY',
  ];
  const INCOME_ONLY_CATS = ['INCOME_1099', 'INCOME_OTHER'];

  return txs.map(t => {
    if (t.tax_category === 'SUBCONTRACTOR' && t.type === 'CREDIT') {
      return {
        ...t,
        tax_category: 'UNCLEAR_UNKNOWN',
        needs_clarification: true,
        coherence_flag: 'SUBCONTRACTOR applied to CREDIT — money came IN from this person. Could be loan repayment, income, or personal transfer. Asking client.',
        clarification_reason: 'This Zelle/transfer received money FROM an individual. Please clarify: did they pay you for work, repay a loan, or send a personal transfer?',
      };
    }
    if (t.type === 'CREDIT' && EXPENSE_ONLY_CATS.includes(t.tax_category)) {
      return {
        ...t,
        tax_category: 'UNCLEAR_UNKNOWN',
        needs_clarification: true,
        coherence_flag: `Expense category "${t.tax_category}" applied to a CREDIT transaction — money came IN. Re-reviewing.`,
      };
    }
    if (t.type === 'DEBIT' && INCOME_ONLY_CATS.includes(t.tax_category)) {
      return {
        ...t,
        tax_category: 'UNCLEAR_UNKNOWN',
        needs_clarification: true,
        coherence_flag: `Income category "${t.tax_category}" applied to a DEBIT — money went OUT. Re-reviewing.`,
      };
    }
    return t;
  });
}

function detectInterAccountTransfers(txs) {
  const bySourceFile = {};
  txs.forEach(t => {
    const f = t._source_file || 'unknown';
    if (!bySourceFile[f]) bySourceFile[f] = [];
    bySourceFile[f].push(t);
  });

  const files = Object.keys(bySourceFile);
  let detected = 0;

  if (files.length < 2) return { txs, detected };

  for (let fi = 0; fi < files.length; fi++) {
    for (let fj = fi + 1; fj < files.length; fj++) {
      const fileA = bySourceFile[files[fi]];
      const fileB = bySourceFile[files[fj]];

      fileA.filter(t => t.type === 'DEBIT').forEach(debit => {
        const match = fileB.find(t =>
          t.type === 'CREDIT' &&
          Math.abs(t.amount - debit.amount) < 0.02 &&
          Math.abs(new Date(t.date) - new Date(debit.date)) <= 86400000
        );
        if (match) {
          detected++;
          debit.tax_category = 'TRANSFER_INTERNAL';
          debit.is_business = false;
          debit.confidence = 'HIGH';
          debit.needs_clarification = false;
          debit.coherence_flag = `Inter-account transfer detected — matched with ${files[fj]} credit of $${match.amount} on ${match.date}`;
          match.tax_category = 'TRANSFER_INTERNAL';
          match.is_business = false;
          match.confidence = 'HIGH';
          match.needs_clarification = false;
          match.coherence_flag = `Inter-account transfer detected — matched with ${files[fi]} debit of $${debit.amount} on ${debit.date}`;
        }
      });
    }
  }

  if (detected > 0)
    console.log(`  🔄 ${detected} inter-account transfer pair(s) detected and resolved`);

  return { txs, detected };
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT 3 — CATEGORISER  (per-statement, not batched)
// Called once per PDF immediately after extract+judge.
// Validates returned array length matches input — rejects + retries if short.
// Pattern cache is saved after each statement so the next one benefits.
// ═══════════════════════════════════════════════════════════════════════════
async function agent3_categorize_statement(ext, stmtLabel) {
  const txs = ext.transactions || [];
  const sourceFile = ext._meta?.source_file || 'unknown';

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  AGENT 3 — CATEGORISER  [${MODEL_CAT} + Google Search]  ${stmtLabel}`);
  console.log(`${'═'.repeat(65)}`);
  console.log(`  🔍 Categorising ${txs.length} transactions from ${sourceFile}`);
  if (patternCache.size > 0)
    console.log(`  🧠 ${patternCache.size} merchants in pattern cache (from prior months)`);
  if (CLIENT_CONTEXT)
    console.log(`  📋 Client context: ${CLIENT_CONTEXT.industries?.join(', ') || 'general'}`);

  const buildPrompt = (retryNote = '') => `You are a US tax categorisation specialist.
You have Google Search — use it for any merchant or code you do not recognise.
Always search, always verify, always document. Client context informs your reasoning
but does not replace verification or documentation.
${retryNote ? `\n⚠️  RETRY NOTE: ${retryNote}\n` : ''}
${'═'.repeat(55)}
${buildIndustryContext(CLIENT_CONTEXT)}

${'═'.repeat(55)}
${buildClientContext(CLIENT_CONTEXT)}

${'═'.repeat(55)}
${buildCacheContext()}

${'═'.repeat(55)}
TAX CATEGORIES — use only these exact codes:
INCOME_1099              — PP companies, platform income, formal business payers
INCOME_OTHER             — Other business income, refunds, informal client payments
FUEL                     — Gas stations
VEHICLE_REPAIR           — Auto parts, oil change, tire, mechanic
VEHICLE_INSURANCE        — Car/truck insurance
VEHICLE_PAYMENT          — Auto loan or lease
PARKING_TOLLS            — Parking, tolls, EZPass
TOOLS_EQUIPMENT          — Hardware stores, tool purchases
EQUIPMENT_RENTAL         — Equipment rental companies
JOB_SUPPLIES             — Materials for specific jobs / COGS for product sellers
COGS_INVENTORY           — Inventory purchases (retail/ecommerce only)
SAFETY_GEAR              — PPE, boots, gloves, hard hat
UNIFORMS                 — Work clothing, branded shirts
PHONE                    — Cell phone bill
INTERNET                 — Internet service
SOFTWARE                 — Business apps, SaaS subscriptions
OFFICE_SUPPLIES          — Printer, paper, pens
SHIPPING                 — FedEx, UPS, USPS
SUBCONTRACTOR            — DEBIT ONLY. Payments TO individuals for work. Flag 1099-NEC.
PROFESSIONAL_FEES        — Accountant, lawyer, notary
INSURANCE_BUSINESS       — Liability, workers comp, commercial insurance
LICENSING                — Permits, business licenses, registrations
MEALS_BUSINESS_CONFIRMED — Business meal, client confirmed who attended and business purpose
MEALS_PERSONAL           — Personal dining, known personal restaurant
MEALS_UNCONFIRMED        — Meal transaction, not yet confirmed as business or personal
PERSONAL_GROCERY         — Grocery stores
PERSONAL_RETAIL          — Amazon, Target, Walmart, Costco (non-grocery, non-business)
PERSONAL_HEALTHCARE      — Medical, pharmacy, doctor
PERSONAL_REPAYMENT       — Returning borrowed money, loan repayment
BANKING_FEE              — Bank fees, ATM fees, overdraft, wire fees
TRANSFER_INTERNAL        — Transfers between own accounts
PERSONAL_OTHER           — Other personal
UNCLEAR_MIXED_USE        — Could be business or personal — needs client clarification
UNCLEAR_CASH_ATM         — ATM withdrawal — needs clarification on how cash was used
UNCLEAR_UNKNOWN          — Searched Google, still unclear — explain what was found

DIRECTION RULES — CRITICAL:
- SUBCONTRACTOR, all expense categories → DEBIT transactions only
- INCOME_1099, INCOME_OTHER → CREDIT transactions only
- If direction conflicts with category, use UNCLEAR_UNKNOWN and flag

CONFIDENCE:
- HIGH:   certain — clear merchant, obvious category
- MEDIUM: reasonable — 70%+ confident
- LOW:    uncertain even after searching — flag for worker

⚠️  CRITICAL COUNT REQUIREMENT:
You MUST return exactly ${txs.length} objects — one for every transaction below.
Do NOT skip, truncate, or summarise. Every line_number must appear in your response.
If your response is cut short, you have failed — retry from where you stopped.

TRANSACTIONS (${txs.length} total — categorise ALL of them):
${JSON.stringify(txs.map(t => ({
    line_number: t.line_number,
    date: t.date,
    description: t.description,
    amount: t.amount,
    type: t.type,
  })), null, 2)}

Return JSON array only — exactly ${txs.length} objects:
[{
  "line_number": 1,
  "tax_category": "CATEGORY_CODE",
  "is_business": true,
  "confidence": "HIGH",
  "needs_clarification": false,
  "clarification_reason": null,
  "suggested_answer": null,
  "source_citations": null,
  "categorization_note": "one sentence reason"
}]

For needs_clarification=true always set suggested_answer.
For SUBCONTRACTOR always set needs_clarification=true and note 1099-NEC.
For MEALS always set needs_clarification=true.`;

  let categorized = null;
  let allSearches = [];

  // Retry loop with length validation
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const retryNote = attempt > 1
      ? `Previous attempt returned ${categorized?.length ?? 0} items but we need exactly ${txs.length}. You MUST categorise every single transaction — do not stop early.`
      : '';

    let response;
    try {
      response = await Promise.race([
        ai.models.generateContent({
          model: MODEL_CAT,
          contents: buildPrompt(retryNote),
          config: {
            temperature: 0.2,
            tools: [{ googleSearch: {} }],
          },
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Agent3 timed out')), AGENT_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      console.log(`  ⚠️  Agent3 attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  ⏳ Waiting ${RETRY_DELAYS[attempt - 1] / 1000}s before retry...`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      throw err;
    }

    tok.record(false, `Agent3 ${stmtLabel} attempt${attempt}`, response.usageMetadata);

    const searches = response.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
    allSearches = allSearches.concat(searches);
    if (searches.length > 0) {
      console.log(`\n  🌐 Google searched ${searches.length} time(s):`);
      searches.forEach(q => console.log(`     → "${q}"`));
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanJSON(response.text));
    } catch (e) {
      console.log(`  ⚠️  Agent3 attempt ${attempt} JSON parse failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  ⏳ Waiting ${RETRY_DELAYS[attempt - 1] / 1000}s before retry...`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      saveJSON({ raw: response.text, error: e.message }, `categorizer_${stmtLabel}_PARSE_FAILED`);
      throw new Error(`Agent 3 JSON parse failed after ${MAX_RETRIES} attempts: ${e.message}`);
    }

    if (!Array.isArray(parsed)) {
      console.log(`  ⚠️  Agent3 attempt ${attempt}: response is not an array`);
      categorized = null;
    } else {
      categorized = parsed;
    }

    // ── LENGTH VALIDATION ─────────────────────────────────────────────────
    // This is the key guard that was missing — catches partial responses
    const missing = txs.length - (categorized?.length ?? 0);
    if (missing > 0) {
      console.log(`  ⚠️  Agent3 attempt ${attempt}: got ${categorized?.length ?? 0}/${txs.length} — ${missing} transactions missing`);
      if (attempt < MAX_RETRIES) {
        console.log(`  ↩️  Retrying — instructing model to return all ${txs.length} transactions...`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      // Max retries hit — fill missing with UNCLEAR_UNKNOWN so nothing is silently dropped
      console.log(`  ⚠️  Max retries reached — filling ${missing} missing transactions as UNCLEAR_UNKNOWN`);
      const returnedLines = new Set((categorized || []).map(c => c.line_number));
      const fallbacks = txs
        .filter(t => !returnedLines.has(t.line_number))
        .map(t => ({
          line_number: t.line_number,
          tax_category: 'UNCLEAR_UNKNOWN',
          is_business: false,
          confidence: 'LOW',
          needs_clarification: true,
          clarification_reason: 'Not categorised — model did not return this transaction after 3 attempts',
          suggested_answer: null,
          source_citations: null,
          categorization_note: 'Fallback — categorisation incomplete, manual review required',
        }));
      categorized = [...(categorized || []), ...fallbacks];
      console.log(`  ✅ Filled with ${fallbacks.length} UNCLEAR_UNKNOWN fallbacks — total now ${categorized.length}`);
    }

    // Good — we have all transactions
    console.log(`  ✅ ${categorized.length}/${txs.length} transactions categorised`);
    break;
  }

  // Merge category data onto raw transactions
  const byLine = {};
  txs.forEach(t => { byLine[t.line_number] = t; });
  let merged = categorized.map(c => ({ ...byLine[c.line_number], ...c }));

  // Coherence check (direction validation)
  merged = coherenceCheck(merged);

  // Learn patterns — this statement's merchants available for next statement
  learnPatterns(merged);

  // Save per-statement categorised JSON
  const stmtSlug = stmtLabel.replace(/\W/g, '_');
  saveJSON({ transactions: merged, _source_file: sourceFile }, `categorized_${stmtSlug}`);

  console.log(`\n  📊 ${stmtLabel} category breakdown:`);
  const byCat = {};
  merged.forEach(t => {
    const c = t.tax_category || 'UNCATEGORIZED';
    if (!byCat[c]) byCat[c] = { count: 0, total: 0 };
    byCat[c].count++;
    byCat[c].total = parseFloat((byCat[c].total + (t.amount || 0)).toFixed(2));
  });
  Object.entries(byCat)
    .sort(([, a], [, b]) => b.total - a.total)
    .forEach(([cat, v]) =>
      console.log(`     ${cat.padEnd(28)} ${String(v.count).padStart(4)} tx   $${v.total.toFixed(2).padStart(12)}`)
    );

  return {
    ...ext,
    transactions: merged,
    _categorization_meta: {
      categorized_at: new Date().toISOString(),
      model: MODEL_CAT,
      google_searches: allSearches,
      search_count: allSearches.length,
      pattern_cache_size: patternCache.size,
      statement_label: stmtLabel,
    },
  };
}

function buildQuestionnaire(txs) {
  const groups = {};

  txs.filter(t => t.needs_clarification).forEach(t => {
    if (t.tax_category === 'SUBCONTRACTOR') {
      const key = `subc_${(t.description || '').toLowerCase().trim()}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
      return;
    }
    if (t.tax_category?.startsWith('MEALS')) {
      const key = `meal_${(t.description || '').slice(0, 15).toLowerCase().trim()}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
      return;
    }
    if (t.tax_category === 'UNCLEAR_CASH_ATM') {
      const month = (t.date || '').slice(0, 7);
      const key = `atm_${month}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
      return;
    }
    const key = (t.description || '').slice(0, 20).toLowerCase().trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  return Object.values(groups).map(grp => {
    const first = grp[0];
    const count = grp.length;
    const total = grp.reduce((s, t) => s + (t.amount || 0), 0);
    const dates = [...new Set(grp.map(t => t.date))].slice(0, 4).join(', ');
    const cat = first.tax_category;
    const taxImpact = (total * 0.28).toFixed(2);

    let question, hint;

    if (cat === 'SUBCONTRACTOR') {
      question = `Payment to "${first.description}" on ${first.date} for $${first.amount?.toFixed(2)} — please confirm this is a contractor you paid for job work. If yes, we may need to file a 1099-NEC if their annual total reaches $600. Please provide their full legal name.`;
      hint = first.suggested_answer || 'Confirm: subcontractor for job work';
    } else if (cat?.startsWith('MEALS')) {
      question = count === 1
        ? `Meal at "${first.description}" on ${first.date} for $${first.amount?.toFixed(2)} — was this a business meal? If yes: who did you eat with, and what was the business purpose? (Required for IRS documentation.)`
        : `${count} meals at "${first.description}" totaling $${total.toFixed(2)} (${dates}) — were any of these business meals? For each business meal, please tell us: who attended and what was discussed.`;
      hint = 'If business: this could save you $' + (total * 0.5 * 0.28).toFixed(2) + ' in taxes (50% of meals is deductible).';
    } else if (cat === 'UNCLEAR_CASH_ATM') {
      const month = (first.date || '').slice(0, 7);
      question = `${count} ATM withdrawal(s) in ${month} totaling $${total.toFixed(2)} — was any of this cash used for business? (e.g. paying helpers, buying supplies, materials, fuel)`;
      hint = `If yes: potential tax savings of $${taxImpact}`;
    } else if (cat === 'UNCLEAR_MIXED_USE') {
      question = count === 1
        ? `${first.description} purchase on ${first.date} for $${first.amount?.toFixed(2)} — was this for business/job supplies, or personal use?`
        : `${count} purchases at "${first.description}" totaling $${total.toFixed(2)} (${dates}) — were any for job supplies or business use?`;
      hint = `If business: potential tax savings of $${taxImpact}`;
    } else if (first.clarification_reason) {
      question = `"${first.description}" on ${first.date} for $${first.amount?.toFixed(2)}: ${first.clarification_reason}`;
      hint = first.suggested_answer || null;
    } else {
      question = `Please clarify "${first.description}" on ${first.date} for $${first.amount?.toFixed(2)} — business or personal?`;
      hint = first.suggested_answer || null;
    }

    return {
      question,
      hint,
      tax_category: cat,
      transaction_count: count,
      total_amount: parseFloat(total.toFixed(2)),
      tax_impact: `If business: saves ~$${taxImpact} in taxes`,
      line_numbers: grp.map(t => t.line_number),
      dates: grp.map(t => t.date),
      merchant: first.description,
      source_citations: first.source_citations || null,
      client_answer: null,
      resolved: false,
    };
  });
}

async function resolveQuestionnaire(answeredQuestions, finalJson) {
  console.log(`\n  📝 Resolving ${answeredQuestions.length} answered question(s)...`);

  let changed = 0;

  for (const q of answeredQuestions) {
    if (!q.client_answer || q.resolved) continue;

    const answer = q.client_answer.toLowerCase().trim();
    const isBiz = answer.includes('yes') || answer.includes('business') ||
      answer.includes('work') || answer.includes('job');
    const isPersonal = answer.includes('no') || answer.includes('personal') ||
      answer.includes('not business');
    const isAmbiguous = !isBiz && !isPersonal;

    for (const lineNum of q.line_numbers) {
      const tx = finalJson.transactions.find(t => t.line_number === lineNum);
      if (!tx) continue;

      if (isAmbiguous) {
        const resolved = await aiResolveTransaction(tx, q.question, q.client_answer);
        if (resolved) {
          Object.assign(tx, resolved, { resolved_by: 'ai_from_client_answer', resolved_at: new Date().toISOString() });
          changed++;
        }
        continue;
      }

      if (isBiz) {
        const cat = q.tax_category === 'UNCLEAR_CASH_ATM' ? 'JOB_SUPPLIES'
          : q.tax_category === 'UNCLEAR_MIXED_USE' ? 'JOB_SUPPLIES'
            : q.tax_category?.startsWith('MEALS') ? 'MEALS_BUSINESS_CONFIRMED'
              : q.tax_category === 'SUBCONTRACTOR' ? 'SUBCONTRACTOR'
                : tx.tax_category;
        Object.assign(tx, {
          tax_category: cat,
          is_business: true,
          confidence: 'HIGH',
          needs_clarification: false,
          resolved_by: 'client_answer',
          resolved_at: new Date().toISOString(),
          client_note: q.client_answer,
        });
        if (cat === 'MEALS_BUSINESS_CONFIRMED') {
          tx.meal_attendees = q.client_answer;
          tx.meal_business_purpose = q.client_answer;
        }
        changed++;
      } else if (isPersonal) {
        Object.assign(tx, {
          tax_category: tx.tax_category?.startsWith('MEALS') ? 'MEALS_PERSONAL' : 'PERSONAL_OTHER',
          is_business: false,
          confidence: 'HIGH',
          needs_clarification: false,
          resolved_by: 'client_answer',
          resolved_at: new Date().toISOString(),
          client_note: q.client_answer,
        });
        changed++;
      }
    }

    q.resolved = true;
  }

  finalJson.summary = buildSummary(finalJson.transactions);
  finalJson._resolution_meta = {
    resolved_at: new Date().toISOString(),
    questions_answered: answeredQuestions.filter(q => q.resolved).length,
    transactions_updated: changed,
  };

  saveJSON(finalJson, 'resolved_FINAL');
  console.log(`  ✅ ${changed} transaction(s) updated from client answers`);
  return finalJson;
}

async function aiResolveTransaction(tx, question, clientAnswer) {
  try {
    const response = await callWithRetry(() =>
      ai.models.generateContent({
        model: MODEL_CAT,
        contents: `A client answered a tax clarification question. Re-categorise this transaction based on their answer.

TRANSACTION: ${JSON.stringify(tx)}
QUESTION: ${question}
CLIENT ANSWER: ${clientAnswer}

Return a single JSON object with only these fields:
{ "tax_category": "", "is_business": true/false, "confidence": "HIGH/MEDIUM/LOW", "categorization_note": "" }`,
        config: { temperature: 0.1 },
      }),
      'AI Resolve Transaction'
    );
    tok.record(false, 'AI Resolve', response.usageMetadata);
    const clean = cleanJSON(response.text);
    return JSON.parse(clean);
  } catch { return null; }
}

function buildSummary(txs) {
  const income = txs.filter(t => t.tax_category?.startsWith('INCOME'));
  const deductions = txs.filter(t => t.is_business === true && t.type === 'DEBIT' && !t.tax_category?.startsWith('MEALS'));
  const mealsConfirmed = txs.filter(t => t.tax_category === 'MEALS_BUSINESS_CONFIRMED');
  const flagged = txs.filter(t => t.needs_clarification);

  const totalDeductions = deductions.reduce((s, t) => s + (t.amount || 0), 0);
  const totalMeals = mealsConfirmed.reduce((s, t) => s + (t.amount || 0), 0);
  const mealsAdj = totalMeals * 0.5;
  const netDeductions = totalDeductions + mealsAdj;

  const byCat = {};
  txs.forEach(t => {
    const c = t.tax_category || 'UNCATEGORIZED';
    if (!byCat[c]) byCat[c] = { count: 0, total: 0 };
    byCat[c].count++;
    byCat[c].total = parseFloat((byCat[c].total + (t.amount || 0)).toFixed(2));
  });

  return {
    total_transactions: txs.length,
    total_income: parseFloat(income.reduce((s, t) => s + (t.amount || 0), 0).toFixed(2)),
    total_income_1099: parseFloat(txs.filter(t => t.tax_category === 'INCOME_1099').reduce((s, t) => s + (t.amount || 0), 0).toFixed(2)),
    total_income_other: parseFloat(txs.filter(t => t.tax_category === 'INCOME_OTHER').reduce((s, t) => s + (t.amount || 0), 0).toFixed(2)),
    gross_deductions: parseFloat(totalDeductions.toFixed(2)),
    meals_confirmed_total: parseFloat(totalMeals.toFixed(2)),
    meals_50pct_deductible: parseFloat(mealsAdj.toFixed(2)),
    net_deductions: parseFloat(netDeductions.toFixed(2)),
    estimated_tax_savings: parseFloat((netDeductions * 0.28).toFixed(2)),
    flagged_for_review: flagged.length,
    high_confidence: txs.filter(t => t.confidence === 'HIGH').length,
    medium_confidence: txs.filter(t => t.confidence === 'MEDIUM').length,
    low_confidence: txs.filter(t => t.confidence === 'LOW').length,
    by_category: byCat,
  };
}

function buildNotifications(txs, ext, interAccountDetected = 0) {
  const notifications = [];

  if (ext._math_warning) {
    notifications.push({
      type: 'MATH_WARNING', severity: 'CRITICAL',
      subject: 'Statement math did not fully reconcile',
      message: ext._math_warning,
      action: 'Review flagged statement manually — some transactions may be missing',
    });
  }

  if (interAccountDetected > 0) {
    notifications.push({
      type: 'INTER_ACCOUNT_TRANSFER_DETECTED', severity: 'INFO',
      subject: `${interAccountDetected} inter-account transfer(s) detected`,
      message: `Found ${interAccountDetected} matching transfer(s) between bank accounts. Both sides marked as TRANSFER_INTERNAL to prevent double-counting.`,
      action: 'Review transfer pairs to confirm they are between your own accounts',
    });
  }

  const subcMap = {};
  txs.filter(t => t.tax_category === 'SUBCONTRACTOR' && t.type === 'DEBIT').forEach(t => {
    const key = (t.description || '').toLowerCase().trim();
    if (!subcMap[key]) subcMap[key] = { name: t.description, total: 0, transactions: [] };
    subcMap[key].total += t.amount || 0;
    subcMap[key].transactions.push({ date: t.date, amount: t.amount, line: t.line_number });
  });

  Object.values(subcMap).forEach(sc => {
    const met = sc.total >= 600;
    notifications.push({
      type: '1099_NEC_CANDIDATE',
      severity: met ? 'HIGH' : 'MEDIUM',
      subject: `Subcontractor: ${sc.name}`,
      message: `Total paid to "${sc.name}": $${sc.total.toFixed(2)}. ${met ? '⚠️  EXCEEDS $600 — 1099-NEC REQUIRED.' : `$${(600 - sc.total).toFixed(2)} below $600 threshold.`}`,
      action: met ? 'Collect legal name + SSN/EIN. File 1099-NEC by Jan 31.' : 'Monitor. File if total reaches $600.',
      total_paid: parseFloat(sc.total.toFixed(2)),
      threshold_met: met,
      transactions: sc.transactions,
    });
  });

  const needsClarif = txs.filter(t => t.needs_clarification && t.tax_category !== 'SUBCONTRACTOR');
  if (needsClarif.length > 0) {
    notifications.push({
      type: 'CLIENT_RESPONSE_NEEDED', severity: 'MEDIUM',
      subject: `${needsClarif.length} transaction(s) need client clarification`,
      message: 'These transactions cannot be definitively categorised without client input.',
      action: 'Send questionnaire to client. Do not file until responses received.',
      count: needsClarif.length,
      total: parseFloat(needsClarif.reduce((s, t) => s + (t.amount || 0), 0).toFixed(2)),
    });
  }

  const phoneTotal = txs.filter(t => t.tax_category === 'PHONE').reduce((s, t) => s + (t.amount || 0), 0);
  if (phoneTotal > 0) {
    const pct = CLIENT_CONTEXT?.phone_business_pct || null;
    notifications.push({
      type: 'PHONE_PRORATION_NEEDED', severity: 'INFO',
      subject: `Phone expenses: $${phoneTotal.toFixed(2)} — proration required`,
      message: pct
        ? `Client stated ${pct}% business use. Deductible portion: $${(phoneTotal * pct / 100).toFixed(2)}`
        : 'IRS requires business vs personal split for phone expenses. Ask client what % is business use.',
      action: pct ? `Apply ${pct}% proration on Schedule C` : 'Ask client for business use percentage',
    });
  }

  const hasCOGS = txs.some(t => t.tax_category === 'COGS_INVENTORY');
  if (hasCOGS) {
    notifications.push({
      type: 'COGS_RECONCILIATION_NEEDED', severity: 'HIGH',
      subject: 'Retail/ecommerce detected — COGS reconciliation required',
      message: 'Product inventory purchases found. Bank statement alone is insufficient for retail businesses. Gross profit cannot be calculated without full inventory records.',
      action: 'Request inventory records, purchase orders, or Shopify/Etsy export from client.',
    });
  }

  txs.filter(t =>
    t.type === 'CREDIT' &&
    t.amount > 500 &&
    !['INCOME_1099', 'INCOME_OTHER', 'TRANSFER_INTERNAL', 'PERSONAL_REPAYMENT'].includes(t.tax_category) &&
    t.confidence !== 'HIGH'
  ).forEach(t => {
    notifications.push({
      type: 'UNVERIFIED_INCOME', severity: 'HIGH',
      subject: `Large unverified credit: $${t.amount} — "${t.description}"`,
      message: `Credit of $${t.amount} on ${t.date} not identified as known income.`,
      action: 'Confirm source with client before filing.',
      line_number: t.line_number,
    });
  });

  const topDeds = Object.entries(
    txs.filter(t => t.is_business === true && t.type === 'DEBIT')
      .reduce((acc, t) => { acc[t.tax_category] = (acc[t.tax_category] || 0) + (t.amount || 0); return acc; }, {})
  ).sort(([, a], [, b]) => b - a).slice(0, 5);

  if (topDeds.length > 0) {
    notifications.push({
      type: 'DEDUCTION_SUMMARY', severity: 'INFO',
      subject: 'Top deduction categories identified',
      message: topDeds.map(([c, v]) => `${c}: $${v.toFixed(2)}`).join(' | '),
      action: 'Review for accuracy before Schedule C filing',
      top_categories: topDeds.map(([cat, total]) => ({ cat, total: parseFloat(total.toFixed(2)) })),
    });
  }

  return notifications;
}


// ═══════════════════════════════════════════════════════════════════════════
// EXCEL BUILDER
// ── FIXES APPLIED (your code base + these changes):
//   1. addCategoryBlock — merged header spanning all columns (no colour bleed)
//   2. addCategoryBlock — startRow advances ONCE per data row (overflow fixed)
//   3. addCategoryBlock — 2 blank gap rows between every category block
//   4. Income/Deductions calls — pass numCols + amtColIdx so subtotal works
//   5. All Transactions — Category column has dropdown (all 35 valid codes)
//   6. All fonts changed Arial → Calibri (universally available in Excel)
// ═══════════════════════════════════════════════════════════════════════════
async function buildExcel(final) {
  const wb = new ExcelJS.Workbook();
  const fn = `${ts()}_REPORT.xlsx`;
  const path = join(OUTPUT_DIR, fn);
  const txs = final.transactions || [];
  const s = final.summary;

  // All valid category codes — used for dropdown on All Transactions sheet
  const ALL_CATEGORIES = [
    'INCOME_1099', 'INCOME_OTHER', 'FUEL', 'VEHICLE_REPAIR', 'VEHICLE_INSURANCE',
    'VEHICLE_PAYMENT', 'PARKING_TOLLS', 'TOOLS_EQUIPMENT', 'EQUIPMENT_RENTAL',
    'JOB_SUPPLIES', 'COGS_INVENTORY', 'SAFETY_GEAR', 'UNIFORMS', 'PHONE', 'INTERNET',
    'SOFTWARE', 'OFFICE_SUPPLIES', 'SHIPPING', 'SUBCONTRACTOR', 'PROFESSIONAL_FEES',
    'INSURANCE_BUSINESS', 'LICENSING', 'MEALS_BUSINESS_CONFIRMED', 'MEALS_PERSONAL',
    'MEALS_UNCONFIRMED', 'PERSONAL_GROCERY', 'PERSONAL_RETAIL', 'PERSONAL_HEALTHCARE',
    'PERSONAL_REPAYMENT', 'BANKING_FEE', 'TRANSFER_INTERNAL', 'PERSONAL_OTHER',
    'UNCLEAR_MIXED_USE', 'UNCLEAR_CASH_ATM', 'UNCLEAR_UNKNOWN',
  ];

  // ── COLOURS ──────────────────────────────────────────────────────────────
  const C = {
    navyBg: '1F3864', white: 'FFFFFF',
    green: 'E2EFDA', blue: 'DDEEFF',
    red: 'FFCCCC', amber: 'FFF2CC',
    purple: 'EDE7F6', altRow: 'F5F5F5',
    subRed: 'FFCDD2', teal: 'E0F2F1',
  };

  function makeHeader(ws, cols, tabColor) {
    ws.columns = cols;
    if (tabColor) ws.properties.tabColor = { argb: tabColor };
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navyBg } };
    row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    row.height = 24;
    row.commit();
  }

  // ── FIX 1, 2, 3: addCategoryBlock rewritten ───────────────────────────────
  // numCols   = total columns in this sheet (merged header + colour span)
  // amtColIdx = 1-based index of the amount column (numFmt + subtotal calc)
  function addCategoryBlock(ws, label, rows, startRow, bgColor, numCols, amtColIdx) {
    // Merged header spanning every column — no colour bleed past table width
    const hRow = ws.getRow(startRow);
    for (let c = 1; c <= numCols; c++) {
      const cell = hRow.getCell(c);
      cell.value = c === 1 ? `◆  ${label}` : null;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '37474F' } };
      cell.font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
    }
    ws.mergeCells(startRow, 1, startRow, numCols);
    hRow.height = 20;
    hRow.commit();
    startRow++;

    // FIX 2: startRow advances exactly once per data row
    rows.forEach((r, i) => {
      const row = ws.getRow(startRow);
      const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? bgColor : C.altRow } };
      r.forEach((val, colIdx) => {
        const cell = row.getCell(colIdx + 1);
        cell.value = val;
        cell.fill = fill;
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'DDDDDD' } } };
        cell.alignment = { vertical: 'middle' };
      });
      if (amtColIdx) {
        row.getCell(amtColIdx).numFmt = '$#,##0.00';
        row.getCell(amtColIdx).alignment = { horizontal: 'right', vertical: 'middle' };
      }
      row.height = 16;
      row.commit();
      startRow++;  // ← ONE increment per row, not per row + extra (overflow fixed)
    });

    // Subtotal row
    const total = rows.reduce((sum, r) => {
      const v = r[(amtColIdx || 3) - 1];
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);
    const subRow = ws.getRow(startRow);
    for (let c = 1; c <= numCols; c++) {
      const cell = subRow.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'ECEFF1' } };
      cell.font = { bold: true, name: 'Calibri', size: 10 };
      if (c === 1) cell.value = `${label} SUBTOTAL`;
      if (c === amtColIdx) { cell.value = total; cell.numFmt = '$#,##0.00'; cell.alignment = { horizontal: 'right' }; }
    }
    subRow.height = 17;
    subRow.commit();

    // FIX 3: 2 blank gap rows between blocks
    ws.getRow(startRow + 1).commit();
    ws.getRow(startRow + 2).commit();
    return startRow + 3;
  }

  // ── SHEET 1: SCHEDULE C SUMMARY ───────────────────────────────────────────
  const ws1 = wb.addWorksheet('Schedule C Summary');
  ws1.properties.tabColor = { argb: '1F3864' };
  ws1.columns = [{ width: 45 }, { width: 20 }, { width: 20 }];

  const addScRow = (label, value, bold = false, money = false, indent = false) => {
    const row = ws1.addRow([indent ? `    ${label}` : label, '', value]);
    row.font = { bold, name: 'Calibri', size: bold ? 11 : 10 };
    if (money && value != null) {
      row.getCell(3).numFmt = '$#,##0.00;($#,##0.00);"-"';
    }
    return row;
  };

  ws1.addRow(['TAXPREP PRO — SCHEDULE C SUMMARY']).font = { bold: true, size: 14, color: { argb: C.navyBg }, name: 'Calibri' };
  ws1.addRow([`Generated: ${new Date().toLocaleString()}`]).font = { italic: true, size: 9, name: 'Calibri' };
  ws1.addRow([`Period: ${final.statements?.map(s => s.period_start + ' → ' + s.period_end).join(' | ') || 'N/A'}`]).font = { size: 9, name: 'Calibri' };
  ws1.addRow([]);
  addScRow('INCOME', '', true);
  addScRow('Line 1 — 1099 Income (PP Companies)', s.total_income_1099, false, true, true);
  addScRow('Line 1 — Other Business Income', s.total_income_other, false, true, true);
  addScRow('TOTAL GROSS INCOME', s.total_income, true, true);
  ws1.addRow([]);
  addScRow('DEDUCTIONS (Schedule C)', '', true);
  addScRow('Line 10 — Commissions / Subcontractor', (final.summary.by_category['SUBCONTRACTOR']?.total || 0), false, true, true);
  addScRow('Line 13 — Depreciation (flag large tools)', 0, false, true, true);
  addScRow('Line 15 — Insurance', (final.summary.by_category['INSURANCE_BUSINESS']?.total || 0), false, true, true);
  addScRow('Line 17 — Legal & Professional', (final.summary.by_category['PROFESSIONAL_FEES']?.total || 0), false, true, true);
  addScRow('Line 20a — Rent / Storage', (final.summary.by_category['RENT_STORAGE']?.total || 0), false, true, true);
  addScRow('Line 22 — Supplies / Materials', ((final.summary.by_category['JOB_SUPPLIES']?.total || 0) + (final.summary.by_category['TOOLS_EQUIPMENT']?.total || 0)), false, true, true);
  addScRow('Line 24a — Meals (50% of confirmed)', s.meals_50pct_deductible, false, true, true);
  addScRow('Line 25 — Phone & Internet', ((final.summary.by_category['PHONE']?.total || 0) + (final.summary.by_category['INTERNET']?.total || 0)), false, true, true);
  addScRow('Line 27a — Other Expenses', ((final.summary.by_category['FUEL']?.total || 0) + (final.summary.by_category['SOFTWARE']?.total || 0) + (final.summary.by_category['BANKING_FEE']?.total || 0)), false, true, true);
  addScRow('TOTAL DEDUCTIONS', s.net_deductions, true, true);
  ws1.addRow([]);
  addScRow('NET PROFIT (Taxable)', parseFloat((s.total_income - s.net_deductions).toFixed(2)), true, true);
  addScRow('Est. Tax Savings @ 28%', s.estimated_tax_savings, true, true);
  ws1.addRow([]);
  addScRow('REVIEW FLAGS', '', true);
  addScRow('Items Needing Client Clarification', s.flagged_for_review, false, false, true);
  addScRow('Transactions — HIGH confidence', s.high_confidence, false, false, true);
  addScRow('Transactions — MEDIUM confidence', s.medium_confidence, false, false, true);
  addScRow('Transactions — LOW confidence', s.low_confidence, false, false, true);

  // ── SHEET 2: INCOME ───────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Income');
  ws2.properties.tabColor = { argb: '2E7D32' };
  ws2.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Payer', key: 'desc', width: 45 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Category', key: 'cat', width: 18 },
    { header: 'Confidence', key: 'conf', width: 11 },
    { header: 'Source Bank', key: 'src', width: 22 },
  ];
  makeHeader(ws2, ws2.columns, '2E7D32');

  let incRow = 2;

  const inc1099 = txs.filter(t => t.tax_category === 'INCOME_1099').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (inc1099.length) {
    // FIX 4: pass numCols=6, amtColIdx=3
    incRow = addCategoryBlock(ws2, '1099 INCOME — Property Preservation Companies',
      inc1099.map(t => [t.date, t.description, t.amount, t.tax_category, t.confidence, t._source_file]),
      incRow, C.green, 6, 3);
  }

  const incOther = txs.filter(t => t.tax_category === 'INCOME_OTHER').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (incOther.length) {
    // FIX 4: pass numCols=6, amtColIdx=3
    incRow = addCategoryBlock(ws2, 'OTHER BUSINESS INCOME',
      incOther.map(t => [t.date, t.description, t.amount, t.tax_category, t.confidence, t._source_file]),
      incRow, C.teal, 6, 3);
  }

  const totRow = ws2.getRow(incRow);
  totRow.getCell(2).value = 'TOTAL INCOME';
  totRow.getCell(3).value = s.total_income;
  totRow.getCell(3).numFmt = '$#,##0.00';
  totRow.font = { bold: true, size: 12, name: 'Calibri' };
  totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navyBg } };
  totRow.getCell(2).font = { bold: true, color: { argb: C.white }, size: 12, name: 'Calibri' };
  totRow.getCell(3).font = { bold: true, color: { argb: C.white }, size: 12, name: 'Calibri' };
  ws2.autoFilter = { from: 'A1', to: 'F1' };

  // ── SHEET 3: DEDUCTIONS ────────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Deductions');
  ws3.properties.tabColor = { argb: 'C62828' };
  ws3.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Payee', key: 'desc', width: 45 },
    { header: 'Amount', key: 'amt', width: 14 },
    { header: 'Confidence', key: 'conf', width: 11 },
    { header: 'Note', key: 'note', width: 40 },
    { header: 'Source', key: 'src', width: 22 },
  ];
  makeHeader(ws3, ws3.columns, 'C62828');

  const deductCats = [
    { key: 'SUBCONTRACTOR', label: 'SUBCONTRACTOR LABOR', color: C.red },
    { key: 'FUEL', label: 'FUEL', color: C.blue },
    { key: 'TOOLS_EQUIPMENT', label: 'TOOLS & EQUIPMENT', color: C.blue },
    { key: 'JOB_SUPPLIES', label: 'JOB SUPPLIES', color: C.blue },
    { key: 'PHONE', label: 'PHONE', color: C.blue },
    { key: 'INTERNET', label: 'INTERNET', color: C.blue },
    { key: 'SOFTWARE', label: 'SOFTWARE', color: C.blue },
    { key: 'INSURANCE_BUSINESS', label: 'INSURANCE', color: C.blue },
    { key: 'PROFESSIONAL_FEES', label: 'PROFESSIONAL FEES', color: C.blue },
    { key: 'VEHICLE_REPAIR', label: 'VEHICLE REPAIR', color: C.blue },
    { key: 'VEHICLE_PAYMENT', label: 'VEHICLE PAYMENT', color: C.blue },
    { key: 'VEHICLE_INSURANCE', label: 'VEHICLE INSURANCE', color: C.blue },
    { key: 'EQUIPMENT_RENTAL', label: 'EQUIPMENT RENTAL', color: C.blue },
    { key: 'BANKING_FEE', label: 'BANKING FEES', color: C.blue },
    { key: 'LICENSING', label: 'LICENSING & PERMITS', color: C.blue },
    { key: 'SHIPPING', label: 'SHIPPING', color: C.blue },
    { key: 'OFFICE_SUPPLIES', label: 'OFFICE SUPPLIES', color: C.blue },
    { key: 'SAFETY_GEAR', label: 'SAFETY GEAR', color: C.blue },
    { key: 'UNIFORMS', label: 'UNIFORMS', color: C.blue },
    { key: 'MEALS_BUSINESS_CONFIRMED', label: 'BUSINESS MEALS (50% deductible)', color: C.amber },
    { key: 'COGS_INVENTORY', label: 'COST OF GOODS SOLD', color: C.purple },
  ];

  let dedRow = 2;
  deductCats.forEach(({ key, label, color }) => {
    const catTxs = txs.filter(t => t.tax_category === key && t.type === 'DEBIT');
    if (!catTxs.length) return;
    // FIX 4: pass numCols=6, amtColIdx=3
    dedRow = addCategoryBlock(ws3, label,
      catTxs.map(t => [t.date, t.description, t.amount, t.confidence, t.categorization_note || '', t._source_file]),
      dedRow, color, 6, 3);
  });

  ws3.autoFilter = { from: 'A1', to: 'F1' };

  // ── SHEET 4: MEALS DETAIL ──────────────────────────────────────────────────
  const ws4 = wb.addWorksheet('Meals Detail');
  ws4.properties.tabColor = { argb: 'F57F17' };
  makeHeader(ws4, [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Restaurant', key: 'desc', width: 35 },
    { header: 'Amount', key: 'amt', width: 12 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Who Attended', key: 'who', width: 25 },
    { header: 'Business Purpose', key: 'purpose', width: 35 },
    { header: '50% Deductible', key: 'ded', width: 14 },
    { header: 'Source', key: 'src', width: 20 },
  ], 'F57F17');

  txs.filter(t => t.tax_category?.startsWith('MEALS')).forEach((t, i) => {
    const isConf = t.tax_category === 'MEALS_BUSINESS_CONFIRMED';
    const isPersonal = t.tax_category === 'MEALS_PERSONAL';
    const row = ws4.addRow({
      date: t.date, desc: t.description, amt: t.amount,
      status: isConf ? '✅ Business Confirmed' : isPersonal ? '❌ Personal' : '⚑ Awaiting Confirmation',
      who: t.meal_attendees || '', purpose: t.meal_business_purpose || '',
      ded: isConf ? t.amount * 0.5 : 0, src: t._source_file,
    });
    row.getCell('amt').numFmt = '$#,##0.00';
    row.getCell('ded').numFmt = '$#,##0.00';
    const bg = isConf ? C.green : isPersonal ? C.red : C.amber;
    row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      c.font = { name: 'Calibri', size: 10 };
    });
  });

  const mealsTotal = ws4.addRow({ desc: 'TOTAL 50% DEDUCTIBLE MEALS', ded: s.meals_50pct_deductible });
  mealsTotal.font = { bold: true, name: 'Calibri' };
  mealsTotal.getCell('ded').numFmt = '$#,##0.00';

  // ── SHEET 5: 1099-NEC TRACKER ──────────────────────────────────────────────
  const ws5 = wb.addWorksheet('1099-NEC Tracker');
  ws5.properties.tabColor = { argb: 'B71C1C' };
  makeHeader(ws5, [
    { header: 'Contractor Name', key: 'name', width: 30 },
    { header: 'YTD Total Paid', key: 'total', width: 16 },
    { header: '$600 Threshold', key: 'threshold', width: 18 },
    { header: '1099-NEC Status', key: 'status', width: 22 },
    { header: '# Payments', key: 'count', width: 12 },
    { header: 'Payment Dates', key: 'dates', width: 40 },
    { header: 'Legal Name ← fill', key: 'legal', width: 25 },
    { header: 'SSN / EIN ← fill', key: 'ssn', width: 18 },
    { header: 'Address ← fill', key: 'address', width: 30 },
    { header: 'Filed? ← fill', key: 'filed', width: 12 },
    { header: 'Action', key: 'action', width: 50 },
  ], 'B71C1C');

  const subcMap = {};
  txs.filter(t => t.tax_category === 'SUBCONTRACTOR' && t.type === 'DEBIT').forEach(t => {
    const key = (t.description || '').toLowerCase().trim();
    if (!subcMap[key]) subcMap[key] = { name: t.description, total: 0, count: 0, dates: [] };
    subcMap[key].total += t.amount || 0;
    subcMap[key].count++;
    subcMap[key].dates.push(t.date);
  });

  if (Object.keys(subcMap).length === 0) {
    ws5.addRow({ name: 'No subcontractor DEBIT payments identified in this period' });
  }

  Object.values(subcMap).sort((a, b) => b.total - a.total).forEach(sc => {
    const met = sc.total >= 600;
    const status = met ? '⚠️  MUST FILE 1099-NEC' : `Monitor ($${(600 - sc.total).toFixed(2)} remaining)`;
    const row = ws5.addRow({
      name: sc.name, total: sc.total,
      threshold: met ? '✅ YES — $600+ REACHED' : `NO — $${sc.total.toFixed(2)} of $600`,
      status, count: sc.count, dates: sc.dates.join(', '),
      legal: '', ssn: '', address: '', filed: '',
      action: met
        ? 'Collect legal name + SSN/EIN + address. File 1099-NEC by Jan 31.'
        : 'Monitor across remaining months. File if total reaches $600.',
    });
    row.getCell('total').numFmt = '$#,##0.00';
    const bg = met ? C.subRed : C.amber;
    row.eachCell((c, cn) => {
      if (['legal', 'ssn', 'address', 'filed'].includes(
        ['', 'name', 'total', 'threshold', 'status', 'count', 'dates', 'legal', 'ssn', 'address', 'filed', 'action'][cn - 1]
      ))
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF' } };
      else
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      c.font = { name: 'Calibri', size: 10 };
    });
  });

  ws5.addRow({}).commit();
  const noteRow = ws5.addRow({ name: '← Tax preparer: fill in Legal Name, SSN/EIN, Address, and Filed columns' });
  noteRow.font = { italic: true, color: { argb: 'AA0000' }, name: 'Calibri', size: 9 };

  // ── SHEET 6: CLIENT QUESTIONNAIRE — sectioned by month ───────────────────
  const ws6 = wb.addWorksheet('Client Questions');
  ws6.properties.tabColor = { argb: 'F9A825' };
  const Q_COLS = [
    { header: '#', key: 'num', width: 5 },
    { header: 'Question', key: 'q', width: 65 },
    { header: 'Hint / Tip', key: 'hint', width: 40 },
    { header: 'Tax Impact', key: 'impact', width: 25 },
    { header: 'Category', key: 'cat', width: 22 },
    { header: 'Amount', key: 'amt', width: 12 },
    { header: 'Your Answer →', key: 'answer', width: 40 },
  ];
  makeHeader(ws6, Q_COLS, 'F9A825');

  // Group questions by month using their transaction dates
  const qByMonth = {};
  (final.client_questions || []).forEach(q => {
    const month = (q.dates?.[0] || '').slice(0, 7) || 'Unknown';
    if (!qByMonth[month]) qByMonth[month] = [];
    qByMonth[month].push(q);
  });

  const sortedQMonths = Object.keys(qByMonth).sort();
  let globalQNum = 1;

  sortedQMonths.forEach(month => {
    const monthQuestions = qByMonth[month];
    const monthLabel = month !== 'Unknown'
      ? new Date(month + '-01').toLocaleString('default', { month: 'long', year: 'numeric' })
      : 'Unknown Period';
    const monthTotal = monthQuestions.reduce((s, q) => s + (q.total_amount || 0), 0);

    // Month section header
    const mHdr = ws6.addRow([`📅  ${monthLabel}  —  ${monthQuestions.length} question(s)  |  Total at stake: $${monthTotal.toFixed(2)}`]);
    mHdr.getCell(1).font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
    mHdr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E65100' } };
    ws6.mergeCells(mHdr.number, 1, mHdr.number, 7);
    mHdr.height = 20;
    mHdr.commit();

    monthQuestions.forEach((q, i) => {
      const row = ws6.addRow({
        num: globalQNum++,
        q: q.question,
        hint: q.hint || '',
        impact: q.tax_impact || '',
        cat: q.tax_category,
        amt: q.total_amount,
        answer: '',
      });
      row.getCell('amt').numFmt = '$#,##0.00';
      row.getCell('q').alignment = { wrapText: true };
      row.getCell('answer').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7' } };
      row.height = 40;
      row.eachCell((c, cn) => {
        if (cn < 7) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? C.altRow : 'FFFFFF' } };
        c.font = { name: 'Calibri', size: 10 };
      });
      row.commit();
    });

    // Month subtotal row
    const qSubRow = ws6.addRow({ num: '', q: `${monthLabel} — SUBTOTAL`, amt: monthTotal });
    qSubRow.getCell('q').font = { bold: true, name: 'Calibri', size: 10 };
    qSubRow.getCell('amt').numFmt = '$#,##0.00';
    qSubRow.getCell('amt').font = { bold: true, name: 'Calibri', size: 10 };
    qSubRow.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E0' } });
    qSubRow.commit();

    // Blank gap row
    ws6.addRow([]).commit();
  });

  // Grand total
  const qGrandTotal = (final.client_questions || []).reduce((s, q) => s + (q.total_amount || 0), 0);
  const qTotRow = ws6.addRow({ q: 'TOTAL ACROSS ALL MONTHS', amt: qGrandTotal });
  qTotRow.getCell('q').font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
  qTotRow.getCell('amt').font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
  qTotRow.getCell('amt').numFmt = '$#,##0.00';
  qTotRow.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navyBg } });
  ws6.mergeCells(qTotRow.number, 1, qTotRow.number, 6);
  qTotRow.commit();

  // ── SHEET 7: ALL TRANSACTIONS — sectioned by month, with dropdown ─────────
  const ws7 = wb.addWorksheet('All Transactions');
  ws7.properties.tabColor = { argb: '37474F' };
  const TX_COLS = [
    { header: '#', key: 'line', width: 6 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Description', key: 'desc', width: 42 },
    { header: 'Amount', key: 'amt', width: 13 },
    { header: 'Type', key: 'type', width: 8 },
    { header: 'Category ▼', key: 'cat', width: 26 },
    { header: 'Business?', key: 'biz', width: 10 },
    { header: 'Confidence', key: 'conf', width: 11 },
    { header: 'Review', key: 'review', width: 8 },
    { header: 'Note', key: 'note', width: 45 },
    { header: 'Bank', key: 'src', width: 22 },
  ];
  makeHeader(ws7, TX_COLS, '37474F');

  // Instruction row
  const instrRow = ws7.getRow(2);
  instrRow.getCell(1).value = '⬇  Column F has a dropdown — change any category to correct categorisation before your tax preparer reviews.';
  instrRow.getCell(1).font = { italic: true, color: { argb: '1565C0' }, name: 'Calibri', size: 9 };
  instrRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E3F2FD' } };
  ws7.mergeCells(2, 1, 2, 11);
  instrRow.commit();

  // Group transactions by month (YYYY-MM)
  const txByMonth = {};
  txs.forEach(t => {
    const month = (t.date || '').slice(0, 7) || 'Unknown';
    if (!txByMonth[month]) txByMonth[month] = [];
    txByMonth[month].push(t);
  });

  const sortedTxMonths = Object.keys(txByMonth).sort();
  let currentRow = 3; // row 1=header, row 2=instruction, data from row 3

  sortedTxMonths.forEach(month => {
    const monthTxs = txByMonth[month];
    const monthLabel = month !== 'Unknown'
      ? new Date(month + '-01').toLocaleString('default', { month: 'long', year: 'numeric' })
      : 'Unknown Period';

    const monthCredits = monthTxs.filter(t => t.type === 'CREDIT').reduce((s, t) => s + (t.amount || 0), 0);
    const monthDebits = monthTxs.filter(t => t.type === 'DEBIT').reduce((s, t) => s + (t.amount || 0), 0);
    const monthBizDed = monthTxs.filter(t => t.is_business && t.type === 'DEBIT').reduce((s, t) => s + (t.amount || 0), 0);
    const monthReview = monthTxs.filter(t => t.needs_clarification).length;

    // Month section header — spans all 11 columns
    const mHdr = ws7.getRow(currentRow);
    for (let c = 1; c <= 11; c++) {
      mHdr.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '263238' } };
      mHdr.getCell(c).font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
    }
    mHdr.getCell(1).value = `📅  ${monthLabel}  —  ${monthTxs.length} transactions  |  Credits: $${monthCredits.toFixed(2)}  |  Debits: $${monthDebits.toFixed(2)}  |  Business Deductions: $${monthBizDed.toFixed(2)}  |  Needs Review: ${monthReview}`;
    ws7.mergeCells(currentRow, 1, currentRow, 11);
    mHdr.height = 20;
    mHdr.commit();
    currentRow++;

    // Data rows for this month
    monthTxs.forEach((t, i) => {
      const row = ws7.getRow(currentRow);

      row.getCell(1).value = t.line_number;
      row.getCell(2).value = t.date;
      row.getCell(3).value = t.description;
      row.getCell(4).value = t.amount;
      row.getCell(4).numFmt = '$#,##0.00;($#,##0.00);"-"';
      row.getCell(5).value = t.type;
      row.getCell(6).value = t.tax_category || 'UNCATEGORIZED';
      row.getCell(7).value = t.is_business === true ? 'YES' : t.is_business === false ? 'NO' : '?';
      row.getCell(8).value = t.confidence || '';
      row.getCell(9).value = t.needs_clarification ? '⚑' : '';
      row.getCell(10).value = [t.categorization_note, t.coherence_flag].filter(Boolean).join(' | ') || '';
      row.getCell(11).value = t._source_file || '';

      // Category dropdown on col 6
      ws7.getCell(currentRow, 6).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: [`"${ALL_CATEGORIES.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Invalid Category',
        error: 'Please select a valid tax category from the dropdown.',
      };

      const bg = t.needs_clarification ? C.amber
        : t.coherence_flag ? C.red
          : t.type === 'CREDIT' ? C.green
            : t.is_business ? C.blue
              : i % 2 === 0 ? C.altRow : 'FFFFFF';

      for (let c = 1; c <= 11; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'DDDDDD' } } };
      }
      row.height = 16;
      row.commit();
      currentRow++;
    });

    // Month subtotal row
    const subRow = ws7.getRow(currentRow);
    for (let c = 1; c <= 11; c++) {
      subRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CFD8DC' } };
      subRow.getCell(c).font = { bold: true, name: 'Calibri', size: 10 };
    }
    subRow.getCell(1).value = `${monthLabel} SUBTOTAL`;
    subRow.getCell(4).value = monthCredits - monthDebits;
    subRow.getCell(4).numFmt = '$#,##0.00;($#,##0.00);"-"';
    subRow.getCell(6).value = `Credits: $${monthCredits.toFixed(2)}  |  Debits: $${monthDebits.toFixed(2)}`;
    ws7.mergeCells(currentRow, 1, currentRow, 3);
    subRow.height = 17;
    subRow.commit();
    currentRow++;

    // Blank gap row between months
    ws7.getRow(currentRow).commit();
    currentRow++;
  });

  // Grand total row
  const totalCredits = txs.filter(t => t.type === 'CREDIT').reduce((s, t) => s + (t.amount || 0), 0);
  const totalDebits = txs.filter(t => t.type === 'DEBIT').reduce((s, t) => s + (t.amount || 0), 0);
  const grandRow = ws7.getRow(currentRow);
  for (let c = 1; c <= 11; c++) {
    grandRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navyBg } };
    grandRow.getCell(c).font = { bold: true, color: { argb: C.white }, name: 'Calibri', size: 11 };
  }
  grandRow.getCell(1).value = `GRAND TOTAL — ${txs.length} transactions`;
  grandRow.getCell(4).value = totalCredits - totalDebits;
  grandRow.getCell(4).numFmt = '$#,##0.00;($#,##0.00);"-"';
  grandRow.getCell(6).value = `Total Credits: $${totalCredits.toFixed(2)}  |  Total Debits: $${totalDebits.toFixed(2)}`;
  ws7.mergeCells(currentRow, 1, currentRow, 3);
  grandRow.height = 22;
  grandRow.commit();

  ws7.autoFilter = { from: 'A1', to: 'K1' };
  ws7.views = [{ state: 'frozen', ySplit: 1 }];

  // ── SHEET 8: PER-BANK SUMMARY ──────────────────────────────────────────────
  const banks = [...new Set(txs.map(t => t._source_file).filter(Boolean))];
  if (banks.length > 1) {
    const ws8 = wb.addWorksheet('Per-Bank Summary');
    ws8.properties.tabColor = { argb: '0277BD' };
    ws8.columns = [{ width: 35 }, { width: 20 }, { width: 20 }, { width: 20 }];
    ws8.addRow(['Bank', 'Total Credits', 'Total Debits', 'Transaction Count'])
      .font = { bold: true, name: 'Calibri' };

    banks.forEach(bank => {
      const bTxs = txs.filter(t => t._source_file === bank);
      const credits = bTxs.filter(t => t.type === 'CREDIT').reduce((s, t) => s + (t.amount || 0), 0);
      const debits = bTxs.filter(t => t.type === 'DEBIT').reduce((s, t) => s + (t.amount || 0), 0);
      const row = ws8.addRow([bank, credits, debits, bTxs.length]);
      row.getCell(2).numFmt = '$#,##0.00';
      row.getCell(3).numFmt = '$#,##0.00';
      row.font = { name: 'Calibri', size: 10 };
    });

    const totRow = ws8.addRow(['COMBINED TOTAL', s.total_income, null, txs.length]);
    totRow.font = { bold: true, name: 'Calibri' };
    totRow.getCell(2).numFmt = '$#,##0.00';
  }

  await wb.xlsx.writeFile(path);
  console.log(`  📊 Excel saved → output/${fn}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// STATEMENT PROCESSOR — extract + judge + categorise, all for one PDF
// ═══════════════════════════════════════════════════════════════════════════
async function processStatement(pdfPath, stmtIndex, totalStmts) {
  const label = `stmt${stmtIndex + 1}_${basename(pdfPath).replace(/\W/g, '_').slice(0, 20)}`;

  // ── Agent 1 + 2 retry loop ────────────────────────────────────────────────
  let ext = null;
  let corrections = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    ext = await agent1_extract(pdfPath, corrections, attempt);
    const { approved, correctionPrompt } = agent2_judge(ext, basename(pdfPath).slice(0, 20));

    if (approved) break;

    if (attempt < MAX_RETRIES) {
      console.log(`\n  ↩️  Sending corrections to Agent 1 (attempt ${attempt + 1})...`);
      corrections = correctionPrompt;
    } else {
      console.log('\n  ⚠️  Max retries reached — proceeding with best result');
      ext._math_warning = `Statement did not fully reconcile after ${MAX_RETRIES} attempts.`;
    }
  }

  // Tag every transaction with its source file before categorising
  const stmtLabel = `${ext.statement_period_start?.slice(0, 7) || label}`;
  ext.transactions = (ext.transactions || []).map(t => ({
    ...t,
    _source_file: ext._meta?.source_file || basename(pdfPath),
  }));

  // ── Agent 3 — categorise this statement right now ─────────────────────────
  const categorised = await agent3_categorize_statement(ext, stmtLabel);

  // Delay before next statement (rate limiting) — skip after last
  if (stmtIndex < totalStmts - 1) {
    console.log(`\n  ⏳ Waiting ${STMT_DELAY_MS / 1000}s before next statement...`);
    await sleep(STMT_DELAY_MS);
  }

  return categorised;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  loadCache();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          TAXPREP PRO — MULTI-AGENT PIPELINE  v4.1           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  📂 ${PDF_PATHS.length} statement(s):`);
  PDF_PATHS.forEach((p, i) => console.log(`     ${i + 1}. ${basename(p)}`));

  if (CLIENT_CONTEXT) {
    console.log(`  📋 Client context: ${CLIENT_CONTEXT.industries?.join(', ') || 'not specified'}`);
    if (CLIENT_CONTEXT.known_people?.length)
      console.log(`  👥 Known people: ${CLIENT_CONTEXT.known_people.map(p => p.name).join(', ')}`);
  } else {
    console.log('  ℹ️  No client context — running with AI reasoning only');
  }

  console.log(`  🕐 Started: ${new Date().toLocaleString()}`);
  console.log(`  🤖 Agent 1: ${MODEL_PRO} (thinking: low)`);
  console.log(`  🔍 Agent 3: ${MODEL_CAT} (per-statement, thinking OFF + Google Search)\n`);

  // ── Process each PDF: extract → judge → categorise → next ─────────────────
  const allCategorised = [];

  for (let i = 0; i < PDF_PATHS.length; i++) {
    console.log(`\n${'━'.repeat(65)}`);
    console.log(`  STATEMENT ${i + 1}/${PDF_PATHS.length}: ${basename(PDF_PATHS[i])}`);
    console.log(`${'━'.repeat(65)}`);

    const result = await processStatement(PDF_PATHS[i], i, PDF_PATHS.length);
    allCategorised.push(result);
  }

  // ── Merge all categorised statements ──────────────────────────────────────
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  MERGING ${allCategorised.length} STATEMENT(S) → FINAL REPORT`);
  console.log(`${'═'.repeat(65)}`);

  let globalLine = 1;
  const allTxs = [];

  allCategorised.forEach(stmt => {
    (stmt.transactions || []).forEach(t => {
      allTxs.push({
        ...t,
        _global_line_number: globalLine++,
      });
    });
  });

  console.log(`  📋 Total transactions across all statements: ${allTxs.length}`);

  // ── Inter-account transfer detection (needs all statements together) ──────
  const { txs: finalTxs, detected } = detectInterAccountTransfers(allTxs);
  if (detected > 0)
    console.log(`  🔄 ${detected} inter-account transfer pair(s) resolved across statements`);

  // ── Build final merged object ─────────────────────────────────────────────
  const allSearches = allCategorised.flatMap(s => s._categorization_meta?.google_searches || []);

  const mergedFinal = {
    account_holder_name: allCategorised[0]?.account_holder_name || 'Unknown',
    bank_name: allCategorised[0]?.bank_name || 'Unknown',
    statements: allCategorised.map(s => ({
      source_file: s._meta?.source_file,
      period_start: s.statement_period_start,
      period_end: s.statement_period_end,
      opening: s.opening_balance,
      closing: s.closing_balance,
      count: s.transactions?.length ?? 0,
      math_warning: s._math_warning || null,
    })),
    transactions: finalTxs,
    _source_files: allCategorised.map(s => s._meta?.source_file),
    _categorization_meta: {
      categorized_at: new Date().toISOString(),
      model: MODEL_CAT,
      google_searches: allSearches,
      search_count: allSearches.length,
      pattern_cache_size: patternCache.size,
      inter_account_transfers_detected: detected,
      statements_processed: allCategorised.length,
    },
  };

  // ── Build questionnaire, notifications, summary ───────────────────────────
  const questions = buildQuestionnaire(finalTxs);
  const notifications = buildNotifications(finalTxs, mergedFinal, detected);
  const summary = buildSummary(finalTxs);

  mergedFinal.summary = summary;
  mergedFinal.client_questions = questions;
  mergedFinal.notifications = notifications;

  saveJSON(mergedFinal, 'categorized_FINAL');
  saveJSON(questions, 'QUESTIONNAIRE');
  saveJSON(notifications, 'NOTIFICATIONS');

  await buildExcel(mergedFinal);

  // ── Final console report ──────────────────────────────────────────────────
  const s = summary;

  console.log('\n  📊 Combined category breakdown:');
  Object.entries(s.by_category)
    .sort(([, a], [, b]) => b.total - a.total)
    .forEach(([cat, v]) =>
      console.log(`     ${cat.padEnd(28)} ${String(v.count).padStart(4)} tx   $${v.total.toFixed(2).padStart(12)}`)
    );

  if (questions.length > 0) {
    console.log(`\n  ❓ ${questions.length} question(s) generated`);
    questions.slice(0, 5).forEach((q, i) => console.log(`     ${i + 1}. ${q.question}`));
    if (questions.length > 5) console.log(`     ... and ${questions.length - 5} more`);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                     PIPELINE COMPLETE                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  Account:            ${mergedFinal.account_holder_name}`);
  mergedFinal.statements?.forEach((st, i) =>
    console.log(`  Statement ${i + 1}:         ${st.period_start} → ${st.period_end}  (${st.count} tx${st.math_warning ? '  ⚠️' : ''})`)
  );
  console.log(`\n  Transactions:       ${s.total_transactions}`);
  console.log(`  1099 Income:        $${s.total_income_1099}`);
  console.log(`  Other Income:       $${s.total_income_other}`);
  console.log(`  Total Income:       $${s.total_income}`);
  console.log(`  Gross Deductions:   $${s.gross_deductions}`);
  console.log(`  Meals (50%):        $${s.meals_50pct_deductible}`);
  console.log(`  Net Deductions:     $${s.net_deductions}`);
  console.log(`  Taxable Profit:     $${(s.total_income - s.net_deductions).toFixed(2)}`);
  console.log(`  Est. Tax Savings:   $${s.estimated_tax_savings}  (@ 28%)`);
  console.log(`  Need Review:        ${s.flagged_for_review} items`);
  console.log(`  Client Questions:   ${questions.length}`);
  console.log(`  Notifications:      ${notifications.length}`);

  tok.print();

  console.log(`\n  📁 Output: ./output/`);
  console.log('     *_extract.json               Raw extraction per statement');
  console.log('     *_judge_verdict.json         Math verification per statement');
  console.log('     *_categorized_<month>.json   Categorised per statement');
  console.log('     *_categorized_FINAL.json     All statements merged');
  console.log('     *_QUESTIONNAIRE.json         Client questions');
  console.log('     *_NOTIFICATIONS.json         Email alerts');
  console.log('     *_REPORT.xlsx                8-sheet Excel workbook');
  console.log('     pattern_cache.json           Persistent merchant cache');
  console.log(`\n  🏁 Finished: ${new Date().toLocaleString()}\n`);
}

main().catch(err => {
  console.error('\n💥 Pipeline crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});\nexport async function runFullTaxPrep(jobId, pdfPaths, clientContext) { /* TODO */ }