// src/services/pdfProcessor.js
// Minimal file validator — confirms the PDF exists and is readable.
// Date extraction is handled by Gemini as part of the extraction response.
// Gap detection runs AFTER extraction using Gemini's returned statement_period dates.

import fs   from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

/**
 * Validate a PDF file is on disk and readable.
 * Returns file metadata only — no parsing, no date extraction.
 *
 * @param {string} filePath     - Absolute path to PDF on disk
 * @param {string} originalname - Original filename for logging
 * @returns {{ filePath, originalname, sizeKb }}
 */
export async function processPDF(filePath, originalname) {
  logger.info('Validating PDF', { originalname });

  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found on disk: ${originalname}`);
  }

  const stats = fs.statSync(filePath);
  const sizeKb = Math.round(stats.size / 1024);

  if (stats.size === 0) {
    throw new Error(`PDF file is empty: ${originalname}`);
  }

  logger.info('PDF validated', { originalname, sizeKb });

  return { filePath, originalname, sizeKb };
}