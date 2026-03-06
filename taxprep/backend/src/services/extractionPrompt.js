// src/services/extractionPrompt.js
// Builds prompts for Gemini PDF extraction.
// Single prompt — no separate text/vision variants needed anymore.

export const TAX_CATEGORIES = [
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
  'meals_entertainment',
  'travel_lodging',
  'banking_fees',
  'software_subscriptions',
  'income_1099',
  'transfer',
  'personal',
  'unknown',
];

export function buildSystemPrompt() {
  return `You are a forensic accounting AI specialising in US tax preparation for 
1099 property preservation contractors. Your job is to extract every financial 
transaction from a bank statement with extreme accuracy.

IMPORTANT RULES:
- Extract EVERY transaction — do not skip any, even small ones
- Never invent or hallucinate transactions not present in the document
- If you cannot read a value clearly, use null — never guess amounts
- Dates must be in YYYY-MM-DD format
- Amounts must be positive numbers (type field distinguishes credit/debit)
- Descriptions should be the exact merchant/payee name as printed

OUTPUT FORMAT: Respond with valid JSON only. No markdown, no explanation, no 
preamble. The JSON must match this exact schema:

{
  "account_number_last4": "1234" | null,
  "statement_period_start": "YYYY-MM-DD" | null,
  "statement_period_end": "YYYY-MM-DD" | null,
  "opening_balance": 1234.56 | null,
  "closing_balance": 1234.56 | null,
  "currency": "USD",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "MERCHANT OR PAYEE NAME",
      "amount": 123.45,
      "type": "debit" | "credit",
      "category": "<one of the tax categories listed below>",
      "is_business": true | false | null,
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "notes": "any relevant note or null"
    }
  ],
  "extraction_notes": "any issues encountered or null"
}

TAX CATEGORIES (use exactly these strings):
${TAX_CATEGORIES.join('\n')}

CATEGORISATION RULES:
- income_1099: credits from known property preservation companies (e.g. Safeguard, 
  MCS, Cyprexx, Five Brothers, Altisource, ServiceLink, Nationstar, etc.)
- subcontractor_labor: large cash withdrawals or Zelle/Venmo/CashApp payments 
  to individuals (not businesses) — flag these
- fuel_mileage: gas stations (Shell, BP, Chevron, Exxon, etc.)
- materials_supplies: Home Depot, Lowe's, Menards, Ace Hardware, etc.
- transfer: transfers between accounts owned by the same person — NOT income
- personal: Netflix, Spotify, groceries, restaurants (non-business meals), etc.
- unknown: anything you cannot confidently categorise

CONFIDENCE LEVELS:
- HIGH: merchant/category match is clear and unambiguous
- MEDIUM: reasonable guess but some uncertainty
- LOW: cannot determine category or business purpose with confidence`;
}

/**
 * Single prompt for direct PDF extraction.
 * No separate text/vision variants — Gemini reads the PDF natively.
 */
export function buildPDFPrompt(filename) {
  return `Extract all transactions from this bank statement PDF.
Filename: ${filename}

Read every page carefully. Extract every transaction row from every table.
Do not skip rows even if they appear faint or are on continuation pages.
Also extract the opening balance, closing balance, statement period dates,
and last 4 digits of the account number if visible.

Return valid JSON only. No markdown formatting.`;
}

/**
 * Parse extraction response.
 * rawMode = true: preserve line_number, running_balance, page_number from Agent 1
 * rawMode = false: standard sanitise for legacy use
 */
export function parseExtractionResponse(raw, rawMode = false) {
  if (!raw) return null;

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.transactions)) return null;

    if (rawMode) {
      // Agent 1 raw mode — preserve all fields exactly as returned
      parsed.transactions = parsed.transactions.map((t, i) => ({
        line_number:     t.line_number     ?? i + 1,
        page_number:     t.page_number     ?? null,
        date:            t.date            || null,
        description:     t.description    || 'UNKNOWN',
        amount:          typeof t.amount === 'number' ? Math.abs(t.amount) : null,
        type:            t.type === 'credit' ? 'credit' : 'debit',
        running_balance: t.running_balance ?? null,
        extraction_note: t.extraction_note || null,
      }));
    } else {
      // Standard mode — sanitise for Supabase
      parsed.transactions = parsed.transactions.map(t => ({
        date:        t.date        || null,
        description: t.description || 'UNKNOWN',
        amount:      typeof t.amount === 'number' ? Math.abs(t.amount) : null,
        type:        t.type === 'credit' ? 'credit' : 'debit',
        category:    TAX_CATEGORIES.includes(t.category) ? t.category : 'unknown',
        is_business: t.is_business ?? null,
        confidence:  ['HIGH', 'MEDIUM', 'LOW'].includes(t.confidence) ? t.confidence : 'LOW',
        notes:       t.notes || null,
      }));
    }

    return parsed;
  } catch {
    return null;
  }
}