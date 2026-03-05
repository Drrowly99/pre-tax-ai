// src/services/gapDetector.js
// Analyses date ranges from processed PDF statements to find missing months.
//
// Called from aiPipeline.js BEFORE AI extraction:
//   const dateRanges = processed.map(f => f.dateRange).filter(r => r.start_date || r.end_date);
//   const gapReport = analyseGaps(dateRanges);
//
// Input:  [{ start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' }, ...]
// Output: { has_gaps, missing_months, overlaps, coverage, ... }

import logger from '../utils/logger.js';

/**
 * Analyse an array of statement date ranges for missing months and overlaps.
 *
 * @param {Array<{ start_date?: string, end_date?: string }>} dateRanges
 * @returns {object} gapReport
 */
export function analyseGaps(dateRanges) {
  logger.info('Starting gap detection', { statementCount: dateRanges.length });

  // ── Handle empty input ────────────────────────────────────────────────────
  if (!dateRanges || dateRanges.length === 0) {
    return {
      has_gaps: false,
      missing_months: [],
      overlaps: [],
      coverage: null,
      warning: 'No date ranges provided — gap detection skipped.',
    };
  }

  // ── Parse + sort all ranges ───────────────────────────────────────────────
  const ranges = dateRanges
    .map(r => ({
      start: r.start_date ? new Date(r.start_date) : null,
      end:   r.end_date   ? new Date(r.end_date)   : null,
    }))
    .filter(r => r.start && r.end && !isNaN(r.start) && !isNaN(r.end))
    .sort((a, b) => a.start - b.start);

  if (ranges.length === 0) {
    return {
      has_gaps: false,
      missing_months: [],
      overlaps: [],
      coverage: null,
      warning: 'No valid date ranges after parsing — gap detection skipped.',
    };
  }

  // ── Overall coverage window ───────────────────────────────────────────────
  const overallStart = ranges[0].start;
  const overallEnd   = ranges.reduce((max, r) => r.end > max ? r.end : max, ranges[0].end);

  // ── Build set of months covered by any statement ──────────────────────────
  const coveredMonths = new Set();

  for (const { start, end } of ranges) {
    const cursor = toMonthStart(start);
    while (cursor <= end) {
      coveredMonths.add(monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  // ── Find missing months in the overall window ─────────────────────────────
  const missingMonths = [];
  const cursor = toMonthStart(overallStart);

  while (cursor <= overallEnd) {
    const key = monthKey(cursor);
    if (!coveredMonths.has(key)) {
      missingMonths.push({
        month:      key,
        start_date: toDateString(new Date(cursor.getFullYear(), cursor.getMonth(), 1)),
        end_date:   toDateString(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)),
        severity:   'missing_month',
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // ── Detect overlapping statement periods ──────────────────────────────────
  const overlaps = [];
  for (let i = 0; i < ranges.length - 1; i++) {
    const a = ranges[i];
    const b = ranges[i + 1];
    if (b.start <= a.end) {
      overlaps.push({
        overlap_start: toDateString(b.start),
        overlap_end:   toDateString(a.end < b.end ? a.end : b.end),
        statement_a_end:   toDateString(a.end),
        statement_b_start: toDateString(b.start),
      });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalMonthsInRange = countMonths(overallStart, overallEnd);
  const monthsWithData     = coveredMonths.size;

  const gapReport = {
    has_gaps:       missingMonths.length > 0,
    missing_months: missingMonths,
    overlaps,
    coverage: {
      start_date:           toDateString(overallStart),
      end_date:             toDateString(overallEnd),
      total_months_in_range: totalMonthsInRange,
      months_with_data:     monthsWithData,
      missing_month_count:  missingMonths.length,
      completeness_pct:     totalMonthsInRange > 0
        ? Number(((monthsWithData / totalMonthsInRange) * 100).toFixed(1))
        : 100,
    },
  };

  logger.info('Gap detection complete', {
    hasGaps:       gapReport.has_gaps,
    missingMonths: missingMonths.length,
    overlaps:      overlaps.length,
    completeness:  gapReport.coverage.completeness_pct + '%',
  });

  return gapReport;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function toMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateString(date) {
  return date.toISOString().split('T')[0];
}

function countMonths(startDate, endDate) {
  let count  = 0;
  const cur  = toMonthStart(startDate);
  while (cur <= endDate) {
    count++;
    cur.setMonth(cur.getMonth() + 1);
  }
  return count;
}

export default analyseGaps;