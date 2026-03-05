// src/services/claudeExtraction.js
// Runs bank statement extraction using Anthropic's Claude API.
// Exports two functions consumed by aiPipeline.js:
//   extractFromText(text, filename)        → uses claude-3-5-sonnet (text)
//   extractFromVision(pageImages, filename) → uses claude-3-5-sonnet (vision)

import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';
import {
  buildSystemPrompt,
  buildTextPrompt,
  buildVisionPrompt,
  parseExtractionResponse,
} from './extractionPrompt.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL         = 'claude-3-5-sonnet-20241022';
const MAX_TOKENS    = 8192;
const MAX_RETRIES   = 2;

// ── TEXT EXTRACTION ───────────────────────────────────────────────────────────

/**
 * Extract transactions from raw PDF text using Claude.
 *
 * @param {string} text       - Raw text content of the PDF
 * @param {string} filename   - Original filename (for logging + prompt context)
 * @returns {object}          - Parsed extraction result or empty fallback
 */
export async function extractFromText(text, filename) {
  logger.info('Claude text extraction started', { filename });

  if (!text || text.trim().length < 50) {
    logger.warn('Claude text extraction skipped — insufficient text', { filename });
    return emptyResult('Insufficient text content for extraction');
  }

  const messages = [
    {
      role: 'user',
      content: buildTextPrompt(text, filename),
    },
  ];

  const raw = await callWithRetry('text', filename, () =>
    client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     buildSystemPrompt(),
      messages,
    })
  );

  if (!raw) return emptyResult('Claude text extraction failed after retries');

  const parsed = parseExtractionResponse(raw);
  if (!parsed) {
    logger.error('Claude text: failed to parse response', { filename });
    return emptyResult('Failed to parse Claude text response');
  }

  logger.info('Claude text extraction complete', {
    filename,
    transactionCount: parsed.transactions.length,
  });

  return parsed;
}

// ── VISION EXTRACTION ─────────────────────────────────────────────────────────

/**
 * Extract transactions from page images using Claude vision.
 *
 * @param {Array<{ base64: string, mediaType: string }>} pageImages
 * @param {string} filename
 * @returns {object}
 */
export async function extractFromVision(pageImages, filename) {
  logger.info('Claude vision extraction started', {
    filename,
    pageCount: pageImages?.length ?? 0,
  });

  if (!pageImages || pageImages.length === 0) {
    logger.warn('Claude vision extraction skipped — no images', { filename });
    return emptyResult('No page images provided');
  }

  // Claude accepts up to 20 images per request — chunk if needed
  const chunks = chunkArray(pageImages, 20);
  const allTransactions = [];
  let meta = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Build content array: images first, then the text prompt
    const content = [
      ...chunk.map(img => ({
        type:   'image',
        source: {
          type:       'base64',
          media_type: img.mediaType || 'image/png',
          data:       img.base64,
        },
      })),
      {
        type: 'text',
        text: buildVisionPrompt(filename, chunk.length),
      },
    ];

    const raw = await callWithRetry(`vision-chunk-${i + 1}`, filename, () =>
      client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     buildSystemPrompt(),
        messages:   [{ role: 'user', content }],
      })
    );

    if (!raw) continue;

    const parsed = parseExtractionResponse(raw);
    if (!parsed) continue;

    allTransactions.push(...parsed.transactions);

    // Use meta from first chunk only
    if (!meta) {
      meta = {
        account_number_last4:  parsed.account_number_last4,
        statement_period_start: parsed.statement_period_start,
        statement_period_end:   parsed.statement_period_end,
        opening_balance:        parsed.opening_balance,
        closing_balance:        parsed.closing_balance,
        currency:               parsed.currency || 'USD',
      };
    }
  }

  if (allTransactions.length === 0) {
    logger.warn('Claude vision: no transactions extracted', { filename });
    return emptyResult('Claude vision found no transactions');
  }

  logger.info('Claude vision extraction complete', {
    filename,
    transactionCount: allTransactions.length,
  });

  return {
    ...(meta || {}),
    transactions:      allTransactions,
    extraction_notes:  null,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Call the Claude API with simple retry logic.
 * Returns the text content of the response, or null on final failure.
 */
async function callWithRetry(label, filename, apiFn) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const response = await apiFn();
      const text = response.content
        ?.filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      return text || null;
    } catch (err) {
      const isLast = attempt === MAX_RETRIES + 1;
      logger.warn(`Claude ${label} attempt ${attempt} failed`, {
        filename,
        error: err.message,
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