// src/services/pdfProcessor.js
// Pre-processes uploaded PDF files before AI extraction.
// For each PDF produces:
//   - text:       raw extracted text (for Claude/Gemini text models)
//   - pageImages: array of base64 PNG images per page (for vision models)
//   - dateRange:  { start_date, end_date } parsed from text (for gap detector)
//
// Called from aiPipeline.js STEP 1 before any AI extraction runs.

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { fromPath } from 'pdf2pic';
import logger from '../utils/logger.js';

const readFile = promisify(fs.readFile);
const exists   = promisify(fs.exists);

// Resolution for page-to-image conversion (higher = better OCR accuracy)
const IMAGE_DPI    = 200;
const IMAGE_FORMAT = 'png';

/**
 * Process a single PDF file — extract text + convert pages to images.
 *
 * @param {string} filePath     - Absolute path to the PDF on disk
 * @param {string} originalname - Original filename for logging
 * @returns {object} { text, pageImages, dateRange, pageCount }
 */
export async function processPDF(filePath, originalname) {
  logger.info('Processing PDF', { originalname });

  if (!fs.existsSync(filePath)) {
    logger.error('PDF file not found', { filePath, originalname });
    throw new Error(`PDF file not found: ${originalname}`);
  }

  const buffer = await readFile(filePath);

  // ── Extract raw text ──────────────────────────────────────────────────────
  let text       = '';
  let pageCount  = 0;

  try {
    const parsed  = await pdfParse(buffer);
    text          = parsed.text || '';
    pageCount     = parsed.numpages || 0;
    logger.info('PDF text extracted', { originalname, pageCount, textLength: text.length });
  } catch (err) {
    logger.warn('PDF text extraction failed — will rely on vision only', {
      originalname,
      error: err.message,
    });
  }

  // ── Convert pages to images for vision models ─────────────────────────────
  let pageImages = [];

  try {
    pageImages = await convertPagesToImages(filePath, pageCount, originalname);
  } catch (err) {
    logger.warn('PDF image conversion failed — will rely on text only', {
      originalname,
      error: err.message,
    });
  }

  // ── Parse date range from text ────────────────────────────────────────────
  const dateRange = extractDateRange(text, originalname);

  logger.info('PDF processing complete', {
    originalname,
    pageCount,
    imageCount: pageImages.length,
    dateRange,
  });

  return {
    text,
    pageImages,
    dateRange,
    pageCount,
  };
}

// ── IMAGE CONVERSION ──────────────────────────────────────────────────────────

async function convertPagesToImages(filePath, pageCount, originalname) {
  // pdf2pic options
  const options = {
    density:     IMAGE_DPI,
    saveFilename: path.basename(filePath, '.pdf'),
    savePath:    path.join(path.dirname(filePath), 'pages'),
    format:      IMAGE_FORMAT,
    width:       1700,
    height:      2200,
  };

  // Ensure output directory exists
  if (!fs.existsSync(options.savePath)) {
    fs.mkdirSync(options.savePath, { recursive: true });
  }

  const converter = fromPath(filePath, options);

  // Determine number of pages if pageCount is 0
  const totalPages = pageCount > 0 ? pageCount : await getPageCount(filePath);

  if (totalPages === 0) {
    logger.warn('Could not determine page count', { originalname });
    return [];
  }

  const images = [];

  for (let page = 1; page <= totalPages; page++) {
    try {
      const result = await converter(page, { responseType: 'base64' });
      if (result?.base64) {
        images.push({
          base64:    result.base64,
          mediaType: 'image/png',
          page,
        });
      }
    } catch (err) {
      logger.warn('Page image conversion failed', { originalname, page, error: err.message });
      // Continue — partial images are better than none
    }
  }

  // Clean up temp image files after converting to base64
  cleanupPageFiles(options.savePath, path.basename(filePath, '.pdf'));

  logger.info('Pages converted to images', { originalname, imageCount: images.length });
  return images;
}

function cleanupPageFiles(dir, basename) {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(basename)) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  } catch {
    // Non-critical — temp files will be cleaned by OS eventually
  }
}

async function getPageCount(filePath) {
  try {
    const buffer = await readFile(filePath);
    const parsed = await pdfParse(buffer);
    return parsed.numpages || 0;
  } catch {
    return 0;
  }
}

// ── DATE RANGE EXTRACTION ─────────────────────────────────────────────────────

/**
 * Attempt to extract statement period dates from raw PDF text.
 * Bank statements typically include "Statement Period: MM/DD/YYYY - MM/DD/YYYY"
 * or similar patterns.
 *
 * Returns { start_date, end_date } in YYYY-MM-DD format, or nulls if not found.
 */
function extractDateRange(text, originalname) {
  if (!text) return { start_date: null, end_date: null };

  // Patterns to try, in order of specificity
  const patterns = [
    // "Statement Period: 01/01/2024 - 01/31/2024"
    /statement\s+period[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–to]+\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // "From: January 1, 2024  To: January 31, 2024"
    /from[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s+to[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    // "01/01/2024 through 01/31/2024"
    /(\d{1,2}\/\d{1,2}\/\d{4})\s+through\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // "Period: 2024-01-01 to 2024-01-31"
    /period[:\s]+(\d{4}-\d{2}-\d{2})\s*[-–to]+\s*(\d{4}-\d{2}-\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const start = parseFlexibleDate(match[1]);
      const end   = parseFlexibleDate(match[2]);

      if (start && end) {
        logger.info('Date range extracted from PDF', { originalname, start, end });
        return { start_date: start, end_date: end };
      }
    }
  }

  // Fallback: find the earliest and latest dates mentioned in the text
  const allDates = extractAllDates(text);
  if (allDates.length >= 2) {
    allDates.sort();
    return {
      start_date: allDates[0],
      end_date:   allDates[allDates.length - 1],
    };
  }

  logger.warn('Could not extract date range from PDF', { originalname });
  return { start_date: null, end_date: null };
}

function parseFlexibleDate(str) {
  if (!str) return null;

  // Try ISO format first
  if (/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) {
    return str.trim();
  }

  // MM/DD/YYYY
  const mdyMatch = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // "January 1, 2024" or "Jan 1 2024"
  const d = new Date(str);
  if (!isNaN(d)) {
    return d.toISOString().split('T')[0];
  }

  return null;
}

function extractAllDates(text) {
  const dates   = [];
  const pattern = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const [, m, d, y] = match;
    const year = parseInt(y);
    // Sanity check — only accept years between 2015 and current year + 1
    if (year >= 2015 && year <= new Date().getFullYear() + 1) {
      dates.push(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    }
  }

  // Deduplicate
  return [...new Set(dates)];
}