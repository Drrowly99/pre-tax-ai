// src/services/agents/categoriserAgent.js
// AGENT 2 — THE CATEGORISER
// Gemini categorises every transaction.
// Google Search is built into Gemini via tools: [{ googleSearch: {} }]
// When Gemini sees an unknown merchant it searches Google on its own.
// No separate search file. No extra API keys.

import fs   from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../../utils/logger.js';
import { TAX_CATEGORIES } from '../extractionPrompt.js';

const genAI   = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
const LOG_DIR = path.join(process.cwd(), 'logs', 'extractions');

const CATEGORISER_SYSTEM_PROMPT = `You are a tax categorisation specialist for US 1099 property preservation contractors.

You will receive a list of raw bank transactions. Categorise each one.

Think carefully. You are an intelligent agent — not a rigid lookup table.
If you see a merchant name or code you do not recognise, use your Google Search 
tool to look it up before deciding. Search for the name, any codes or abbreviations,
and determine what type of business it is.

Reason about each transaction based on:
- The description and any codes or abbreviations
- The amount (large round numbers to individuals = likely subcontractor labor)
- The transaction type (debit vs credit)
- Patterns (recurring same amount = subscription)
- Industry context (property preservation, construction, maintenance)

TAX CATEGORIES — use exactly these strings:
${TAX_CATEGORIES.join('\n')}

CATEGORY RULES:
- income_1099: credits from property preservation companies (Safeguard, MCS, Cyprexx,
  Five Brothers, Altisource, ServiceLink, Nationstar, CWIS, Berghorst, Chronos, etc.)
- subcontractor_labor: Zelle/Venmo/CashApp/PayPal to individuals, large cash withdrawals,
  checks to persons — ALWAYS flag these, may need 1099-NEC
- fuel_mileage: Shell, BP, Chevron, Exxon, Murphy, Circle K, Speedway, QT, Wawa, Sunoco
- materials_supplies: Home Depot, Lowe's, Menards, Ace Hardware, True Value, 84 Lumber
- transfer: ACH transfer, Zelle to self, between own accounts — NOT income
- personal: Netflix, Spotify, Amazon Prime, groceries, clothing, restaurants without business context
- unknown: only if you genuinely cannot determine even after searching

CONFIDENCE:
- HIGH: certain — clear merchant name, obvious category
- MEDIUM: reasonable inference — 70%+ confident
- LOW: uncertain even after searching — flag for worker

FOR EACH TRANSACTION return all original fields plus:
  "category": string,
  "is_business": true | false | null,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "brief explanation",
  "needs_clarification": true | false,
  "notes": "search findings or null"

Return valid JSON array only. No markdown. Preserve every field. Do not drop any transactions.`;

export async function runCategoriserAgent(rawResult, filename, jobId) {
  logger.info('[Agent 2] Categoriser started', {
    filename,
    transactionCount: rawResult.transactions?.length ?? 0,
  });

  ensureLogDir();

  if (!rawResult.transactions?.length) {
    logger.warn('[Agent 2] No transactions to categorise', { filename });
    return rawResult;
  }

  const model = genAI.getGenerativeModel({
    model:             MODEL,
    generationConfig:  { temperature: 0.2, maxOutputTokens: 16384 },
    systemInstruction: CATEGORISER_SYSTEM_PROMPT,
    tools:             [{ googleSearch: {} }],  // Gemini searches Google on its own
  });

  const prompt = `Categorise every transaction in this list.
For any merchant you do not recognise, search Google before deciding.
Filename: ${filename}

TRANSACTIONS:
${JSON.stringify(rawResult.transactions, null, 2)}

Return the complete array with all fields preserved and category/confidence/reasoning added.
Valid JSON array only — no wrapper object, just the array.`;

  let categorised = null;

  try {
    const result = await model.generateContent([{ text: prompt }]);
    const raw    = result.response.text();
    const clean  = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(clean);
    categorised  = Array.isArray(parsed) ? parsed : parsed.transactions || null;
  } catch (err) {
    logger.error('[Agent 2] Categorisation failed', { filename, error: err.message });
    saveJSON(jobId, filename, 'categorised_failed', rawResult);
    return rawResult;
  }

  if (!categorised) {
    logger.error('[Agent 2] Could not parse categorisation response', { filename });
    return rawResult;
  }

  const finalResult = { ...rawResult, transactions: categorised };

  saveJSON(jobId, filename, 'categorised_final', finalResult);

  logger.info('[Agent 2] Categoriser complete', {
    filename,
    total:       categorised.length,
    highConf:    categorised.filter(t => t.confidence === 'HIGH').length,
    mediumConf:  categorised.filter(t => t.confidence === 'MEDIUM').length,
    lowConf:     categorised.filter(t => t.confidence === 'LOW').length,
    unknown:     categorised.filter(t => t.category === 'unknown').length,
    needsClarif: categorised.filter(t => t.needs_clarification).length,
  });

  return finalResult;
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function saveJSON(jobId, filename, label, data) {
  try {
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(LOG_DIR, `${ts}_${safeName}_${label}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.info('[Agent 2] JSON saved', { file: path.basename(filePath) });
  } catch (err) {
    logger.warn('[Agent 2] Failed to save JSON log', { error: err.message });
  }
}