// src/services/geminiExtraction.js
// Runs bank statement extraction using Google's Gemini API.
// Exports two functions consumed by aiPipeline.js:
//   extractFromText(text, filename)        → uses gemini-1.5-pro (text)
//   extractFromVision(pageImages, filename) → uses gemini-1.5-pro (vision)
//
// Mirrors the interface of claudeExtraction.js exactly so the pipeline
// can call both in Promise.all() without special-casing.

import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger.js';
import {
  buildSystemPrompt,
  buildTextPrompt,
  buildVisionPrompt,
  parseExtractionResponse,
} from './extractionPrompt.js';

const genAI       = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL       = 'gemini-2.5-pro';
const MAX_RETRIES = 2;

// Gemini config — match Claude's instruction style
const GENERATION_CONFIG = {
  temperature:     0.1,   // low temp = consistent, factual extraction
  topP:            0.8,
  maxOutputTokens: 8192,
};

// ── TEXT EXTRACTION ───────────────────────────────────────────────────────────

/**
 * Extract transactions from raw PDF text using Gemini.
 *
 * @param {string} text       - Raw text content of the PDF
 * @param {string} filename   - Original filename
 * @returns {object}          - Parsed extraction result or empty fallback
 */
export async function extractFromText(text, filename) {
  logger.info('Gemini text extraction started', { filename });

  if (!text || text.trim().length < 50) {
    logger.warn('Gemini text extraction skipped — insufficient text', { filename });
    return emptyResult('Insufficient text content for extraction');
  }

  const model = genAI.getGenerativeModel({
    model:            MODEL,
    generationConfig: GENERATION_CONFIG,
    systemInstruction: buildSystemPrompt(),
  });

  const prompt = buildTextPrompt(text, filename);

  const raw = await callWithRetry('text', filename, () =>
    model.generateContent(prompt)
  );

  if (!raw) return emptyResult('Gemini text extraction failed after retries');

  const parsed = parseExtractionResponse(raw);
  if (!parsed) {
    logger.error('Gemini text: failed to parse response', { filename });
    return emptyResult('Failed to parse Gemini text response');
  }

  logger.info('Gemini text extraction complete', {
    filename,
    transactionCount: parsed.transactions.length,
  });

  return parsed;
}

// ── VISION EXTRACTION ─────────────────────────────────────────────────────────

/**
 * Extract transactions from page images using Gemini vision.
 *
 * @param {Array<{ base64: string, mediaType: string }>} pageImages
 * @param {string} filename
 * @returns {object}
 */
export async function extractFromVision(pageImages, filename) {
  logger.info('Gemini vision extraction started', {
    filename,
    pageCount: pageImages?.length ?? 0,
  });

  if (!pageImages || pageImages.length === 0) {
    logger.warn('Gemini vision extraction skipped — no images', { filename });
    return emptyResult('No page images provided');
  }

  const model = genAI.getGenerativeModel({
    model:            MODEL,
    generationConfig: GENERATION_CONFIG,
    systemInstruction: buildSystemPrompt(),
  });

  // Gemini can handle many images in one request — send all at once
  // but chunk at 16 pages to stay within token limits
  const chunks = chunkArray(pageImages, 16);
  const allTransactions = [];
  let meta = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Build Gemini parts array: images + text prompt
    const parts = [
      ...chunk.map(img => ({
        inlineData: {
          mimeType: img.mediaType || 'image/png',
          data:     img.base64,
        },
      })),
      { text: buildVisionPrompt(filename, chunk.length) },
    ];

    const raw = await callWithRetry(`vision-chunk-${i + 1}`, filename, () =>
      model.generateContent({ contents: [{ role: 'user', parts }] })
    );

    if (!raw) continue;

    const parsed = parseExtractionResponse(raw);
    if (!parsed) continue;

    allTransactions.push(...parsed.transactions);

    if (!meta) {
      meta = {
        account_number_last4:   parsed.account_number_last4,
        statement_period_start: parsed.statement_period_start,
        statement_period_end:   parsed.statement_period_end,
        opening_balance:        parsed.opening_balance,
        closing_balance:        parsed.closing_balance,
        currency:               parsed.currency || 'USD',
      };
    }
  }

  if (allTransactions.length === 0) {
    logger.warn('Gemini vision: no transactions extracted', { filename });
    return emptyResult('Gemini vision found no transactions');
  }

  logger.info('Gemini vision extraction complete', {
    filename,
    transactionCount: allTransactions.length,
  });

  return {
    ...(meta || {}),
    transactions:     allTransactions,
    extraction_notes: null,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Call Gemini with retry logic.
 * Returns the text response string, or null on final failure.
 */
async function callWithRetry(label, filename, apiFn) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const result   = await apiFn();
      const response = result.response;
      const text     = response.text();
      return text || null;
    } catch (err) {
      const isLast = attempt === MAX_RETRIES + 1;
      logger.warn(`Gemini ${label} attempt ${attempt} failed`, {
        filename,
        error:     err.message,
        willRetry: !isLast,
      });

      if (isLast) return null;

      // Exponential backoff: 2s, 4s
      await sleep(2000 * attempt);
    }
  }
  return null;
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
  };
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}