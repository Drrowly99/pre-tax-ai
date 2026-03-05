// src/services/extractionPrompt.js
// Builds the extraction prompts used by both Claude and Gemini.
// Keeping prompts in one place means both models get identical instructions —
// making the Judge's reconciliation job easier.

/**
 * US property preservation tax categories for 1099 contractors.
 * These map to Schedule C line items.
 */
export const TAX_CATEGORIES = [
  'materials_supplies',        // lumber, hardware, cleaning supplies, etc.
  'tools_equipment',           // power tools, ladders, equipment purchases
  'fuel_mileage',              // gas stations, fuel cards
  'vehicle_maintenance',       // oil changes, tires, repairs
  'subcontractor_labor',       // payments to other workers / crews
  'dump_fees_disposal',        // landfill, junk removal, dumpster rental
  'permits_fees',              // city permits, inspection fees
  'insurance',                 // liability insurance, workers comp
  'phone_internet',            // business phone, hotspot
  'advertising_marketing',     // listings, flyers, online ads
  'office_supplies',           // printer, paper, pens
  'professional_services',     // accountant, attorney
  'rent_storage',              // storage unit, shop rent
  'utilities',                 // job-site utilities
  'meals_entertainment',       // business meals (50% deductible)
  'travel_lodging',            // hotels, flights for work
  'banking_fees',              // bank charges, wire fees
  'software_subscriptions',    // apps, SaaS tools
  'income_1099',               // money received FROM clients (revenue)
  'transfer',                  // internal account transfer (not income/expense)
  'personal',                  // clearly personal — not deductible
  'unknown',                   // cannot determine — needs clarification
];

/**
 * Build the system prompt — identical for text and vision modes.
 * Instructs the model on its role, output format, and field definitions.
 */
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
 * Build the user prompt for TEXT-based extraction.
 *
 * @param {string} text         - Raw text extracted from the PDF
 * @param {string} filename     - Original filename (for context)
 */
export function buildTextPrompt(text, filename) {
  return `Extract all transactions from this bank statement.
Filename: ${filename}

STATEMENT TEXT:
---
${text}
---

Return valid JSON only. No markdown formatting.`;
}

/**
 * Build the user prompt for VISION-based extraction.
 * The actual image bytes are passed separately by the calling service.
 *
 * @param {string} filename     - Original filename (for context)
 * @param {number} pageCount    - Number of pages being sent
 */
export function buildVisionPrompt(filename, pageCount) {
  return `Extract all transactions from this bank statement image${pageCount > 1 ? 's' : ''}.
Filename: ${filename}
Pages: ${pageCount}

Carefully read every row in the transaction table(s). Do not skip rows even if 
they are faint or partially cut off. Return valid JSON only. No markdown.`;
}

/**
 * Safely parse the model's JSON response.
 * Returns null if parsing fails — caller handles the fallback.
 *
 * @param {string} raw  - Raw string response from model
 */
export function parseExtractionResponse(raw) {
  if (!raw) return null;

  // Strip markdown code fences if model added them despite instructions
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);

    // Validate minimum required shape
    if (!Array.isArray(parsed.transactions)) {
      return null;
    }

    // Sanitise each transaction
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

    return parsed;
  } catch {
    return null;
  }
}