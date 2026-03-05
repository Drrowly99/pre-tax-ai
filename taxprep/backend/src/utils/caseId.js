// src/utils/caseId.js
// Generate and validate case IDs in the format TX-YYYYMMDD-XXXX
// Example: TX-20260305-A7K2
//
// Export: { generate, validate, extract }

import supabase from './supabase.js';
import logger   from './logger.js';

const PATTERN = /^TX-(\d{8})-([A-Z0-9]{4})$/;
const CHARS   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_RETRIES = 5;

/**
 * Generate a unique case ID.
 * Checks Supabase to guarantee no collision.
 *
 * @returns {Promise<string>}  e.g. "TX-20260305-A7K2"
 */
export async function generate() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const id = buildId();

    const { data } = await supabase
      .from('jobs')
      .select('id')
      .eq('case_id', id)
      .maybeSingle();

    if (!data) {
      // No collision — this ID is free
      return id;
    }

    logger.warn('Case ID collision — retrying', { id, attempt });
  }

  throw new Error('Failed to generate unique case ID after max retries');
}

/**
 * Validate a case ID string.
 *
 * @param {string} caseId
 * @returns {boolean}
 */
export function validate(caseId) {
  if (typeof caseId !== 'string') return false;
  return PATTERN.test(caseId);
}

/**
 * Parse a case ID into its components.
 *
 * @param {string} caseId
 * @returns {{ date: Date, suffix: string } | null}
 */
export function extract(caseId) {
  if (!validate(caseId)) return null;

  const [, datePart, suffix] = caseId.match(PATTERN);

  const year  = parseInt(datePart.slice(0, 4));
  const month = parseInt(datePart.slice(4, 6)) - 1; // 0-indexed
  const day   = parseInt(datePart.slice(6, 8));

  return {
    date: new Date(year, month, day),
    suffix,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function buildId() {
  const now    = new Date();
  const y      = now.getFullYear();
  const m      = String(now.getMonth() + 1).padStart(2, '0');
  const d      = String(now.getDate()).padStart(2, '0');
  const suffix = Array.from({ length: 4 }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('');

  return `TX-${y}${m}${d}-${suffix}`;
}