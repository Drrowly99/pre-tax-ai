// src/services/excelExport.js
// Generates the 5-sheet Excel workbook delivered to the client after balance payment.
// Uses exceljs.
//
// Sheets:
//   1. Summary          — overview, totals, warnings
//   2. All Transactions — every transaction, colour coded
//   3. Business Expenses — Schedule C ready, subtotals per category
//   4. Items Needing Input — needs_clarification transactions
//   5. Subcontractors   — potential 1099-NEC recipients
//
// Export: generateExcel(jobId) → Promise<Buffer>

import ExcelJS from 'exceljs';
import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

// ── COLOURS ───────────────────────────────────────────────────────────────────
const COLOURS = {
  headerBg:     '00796B',  // teal
  headerText:   'FFFFFF',
  highConf:     'E8F5E9',  // green  — high confidence business expense
  needsReview:  'FFFDE7',  // yellow — medium confidence / needs clarification
  mathIssue:    'FFEBEE',  // red    — low consensus or math flag
  personal:     'F5F5F5',  // grey   — personal expense
  subtotalBg:   'E0F2F1',  // light teal — subtotal rows
  grandTotalBg: '00796B',  // teal   — grand total row
  grandTotalFg: 'FFFFFF',
  warningBg:    'FFF9C4',  // pale yellow — warning sections
};

/**
 * Generate the complete Excel workbook for a job.
 *
 * @param {string} jobId
 * @returns {Promise<Buffer>}
 */
export async function generateExcel(jobId) {
  logger.info('Excel generation started', { jobId });

  // ── Fetch all data ────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (jobErr || !job) throw new Error(`Job not found: ${jobId}`);

  const { data: transactions = [] } = await supabase
    .from('transactions')
    .select('*')
    .eq('job_id', jobId)
    .order('date', { ascending: true });

  const { data: questions = [] } = await supabase
    .from('clarification_questions')
    .select('*')
    .eq('job_id', jobId);

  const taxYear      = job.tax_year || new Date().getFullYear() - 1;
  const gapReport    = job.gap_report || {};
  const subWarnings  = job.subcontractor_warnings || [];
  const summary      = job.financial_summary || {};

  // ── Build workbook ────────────────────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  workbook.creator  = 'TaxPrep Pro';
  workbook.created  = new Date();
  workbook.modified = new Date();

  buildSummarySheet(workbook, job, summary, gapReport, taxYear);
  buildAllTransactionsSheet(workbook, transactions);
  buildBusinessExpensesSheet(workbook, transactions);
  buildNeedsInputSheet(workbook, transactions, questions);
  buildSubcontractorsSheet(workbook, subWarnings);

  // ── Serialise to buffer ───────────────────────────────────────────────────
  const buffer = await workbook.xlsx.writeBuffer();

  logger.info('Excel generation complete', {
    jobId,
    caseId:       job.case_id,
    transactions: transactions.length,
    sizeKb:       Math.round(buffer.byteLength / 1024),
  });

  return buffer;
}

// ── SHEET 1: SUMMARY ──────────────────────────────────────────────────────────

function buildSummarySheet(workbook, job, summary, gapReport, taxYear) {
  const ws = workbook.addWorksheet('Summary');
  ws.columns = [
    { width: 40 },
    { width: 20 },
  ];

  // Title
  addMergedTitle(ws, 'Tax Pre-Processing Report', 1, 'A1:B1', 16, true);
  addMergedTitle(ws, 'Prepared by TaxPrep Pro', 2, 'A2:B2', 11, false);
  ws.addRow([]);

  // Case info
  addLabelValue(ws, 'Case ID',        job.case_id);
  addLabelValue(ws, 'Client Name',    job.client_name    || '—');
  addLabelValue(ws, 'Company',        job.company_name   || '—');
  addLabelValue(ws, 'Tax Year',       taxYear);
  addLabelValue(ws, 'Date Prepared',  new Date().toLocaleDateString('en-US'));
  ws.addRow([]);

  // Totals header
  const hdrRow = ws.addRow(['Financial Summary', '']);
  styleHeaderRow(hdrRow);
  ws.mergeCells(`A${hdrRow.number}:B${hdrRow.number}`);

  addLabelValue(ws, 'Total 1099 Income',           fmt(summary.total_income_1099));
  addLabelValue(ws, 'Total Business Deductions',   fmt(summary.total_deductions));
  addLabelValue(ws, `Estimated Tax Savings (${summary.estimated_tax_rate_pct || 28}% — estimate only)`,
    fmt(summary.estimated_tax_savings));
  addLabelValue(ws, 'Total Transactions Reviewed', summary.transaction_count || 0);
  addLabelValue(ws, 'Items Needing Your Input',    summary.clarification_count || 0);
  ws.addRow([]);

  // Gap warning
  if (gapReport.has_gaps && gapReport.missing_months?.length > 0) {
    const months = gapReport.missing_months.map(m => m.month).join(', ');
    const warnRow = ws.addRow([
      `⚠️  WARNING: Statements for ${months} were not available. ` +
      `Deductions may be incomplete. Provide these to your accountant.`,
      '',
    ]);
    ws.mergeCells(`A${warnRow.number}:B${warnRow.number}`);
    warnRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOURS.warningBg } };
    warnRow.getCell(1).font = { bold: true, color: { argb: 'B71C1C' } };
    warnRow.getCell(1).alignment = { wrapText: true };
    warnRow.height = 40;
    ws.addRow([]);
  }

  // Footer disclaimer
  const footerRow = ws.addRow([
    'This is a pre-processing report, not tax advice. ' +
    'Consult a licensed CPA for final tax preparation.',
    '',
  ]);
  ws.mergeCells(`A${footerRow.number}:B${footerRow.number}`);
  footerRow.getCell(1).font      = { italic: true, size: 9, color: { argb: '757575' } };
  footerRow.getCell(1).alignment = { wrapText: true };
}

// ── SHEET 2: ALL TRANSACTIONS ─────────────────────────────────────────────────

function buildAllTransactionsSheet(workbook, transactions) {
  const ws = workbook.addWorksheet('All Transactions');

  ws.columns = [
    { header: 'Date',        key: 'date',        width: 14 },
    { header: 'Description', key: 'description', width: 35 },
    { header: 'Amount',      key: 'amount',       width: 14 },
    { header: 'Type',        key: 'type',         width: 10 },
    { header: 'Category',    key: 'category',     width: 22 },
    { header: 'Business?',   key: 'business',     width: 12 },
    { header: 'Confidence',  key: 'confidence',   width: 12 },
    { header: 'Notes',       key: 'notes',        width: 30 },
  ];

  styleHeaderRow(ws.getRow(1));
  ws.getRow(1).height = 20;

  for (const t of transactions) {
    const row = ws.addRow({
      date:        t.date,
      description: t.description,
      amount:      parseFloat(t.amount) || 0,
      type:        t.type,
      category:    formatCategory(t.category),
      business:    t.is_business === true ? 'Yes' : t.is_business === false ? 'No' : '?',
      confidence:  t.confidence || '',
      notes:       t.notes || '',
    });

    // Amount as currency
    row.getCell('amount').numFmt = '$#,##0.00';

    // Colour coding
    const bgColour = getRowColour(t);
    if (bgColour) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColour } };
      });
    }
  }

  ws.autoFilter = { from: 'A1', to: 'H1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function getRowColour(t) {
  if (t.consensus_score === 1 || t.ai_failed)  return COLOURS.mathIssue;
  if (t.needs_clarification)                   return COLOURS.needsReview;
  if (t.is_business === true && t.confidence === 'HIGH') return COLOURS.highConf;
  if (t.is_business === false)                 return COLOURS.personal;
  if (t.confidence === 'MEDIUM')               return COLOURS.needsReview;
  return null;
}

// ── SHEET 3: BUSINESS EXPENSES ────────────────────────────────────────────────

function buildBusinessExpensesSheet(workbook, transactions) {
  const ws = workbook.addWorksheet('Business Expenses');

  // Label at top
  const labelRow = ws.addRow(['Schedule C Ready — Business Expenses Only', '', '', '', '', '']);
  ws.mergeCells(`A1:F1`);
  labelRow.getCell(1).font      = { bold: true, size: 12 };
  labelRow.getCell(1).alignment = { horizontal: 'center' };
  ws.addRow([]);

  ws.columns = [
    { header: 'Date',        key: 'date',        width: 14 },
    { header: 'Description', key: 'description', width: 35 },
    { header: 'Amount',      key: 'amount',       width: 14 },
    { header: 'Category',    key: 'category',     width: 22 },
    { header: 'Confidence',  key: 'confidence',   width: 12 },
    { header: 'Source File', key: 'source_file',  width: 25 },
  ];

  const headerRow = ws.getRow(3);
  styleHeaderRow(headerRow);

  // Filter and group by category
  const bizTx = transactions
    .filter(t => t.is_business === true)
    .sort((a, b) => {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      return new Date(a.date) - new Date(b.date);
    });

  let currentCategory = null;
  let categoryTotal   = 0;
  let grandTotal      = 0;

  for (const t of bizTx) {
    // Subtotal row when category changes
    if (currentCategory !== null && t.category !== currentCategory) {
      addSubtotalRow(ws, currentCategory, categoryTotal);
      categoryTotal = 0;
    }

    currentCategory = t.category;
    const amount    = parseFloat(t.amount) || 0;
    categoryTotal  += amount;
    grandTotal     += amount;

    const row = ws.addRow({
      date:        t.date,
      description: t.description,
      amount,
      category:    formatCategory(t.category),
      confidence:  t.confidence,
      source_file: t.source_file || '',
    });
    row.getCell('amount').numFmt = '$#,##0.00';
  }

  // Final subtotal
  if (currentCategory !== null) {
    addSubtotalRow(ws, currentCategory, categoryTotal);
  }

  // Grand total
  ws.addRow([]);
  const totalRow = ws.addRow(['', 'GRAND TOTAL', grandTotal, '', '', '']);
  totalRow.getCell(2).font = { bold: true, color: { argb: COLOURS.grandTotalFg } };
  totalRow.getCell(3).font = { bold: true, color: { argb: COLOURS.grandTotalFg } };
  totalRow.getCell(3).numFmt = '$#,##0.00';
  totalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOURS.grandTotalBg } };
  });
}

function addSubtotalRow(ws, category, total) {
  const row = ws.addRow(['', `Subtotal — ${formatCategory(category)}`, total, '', '', '']);
  row.getCell(2).font   = { bold: true };
  row.getCell(3).font   = { bold: true };
  row.getCell(3).numFmt = '$#,##0.00';
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOURS.subtotalBg } };
  });
}

// ── SHEET 4: ITEMS NEEDING INPUT ──────────────────────────────────────────────

function buildNeedsInputSheet(workbook, transactions, questions) {
  const ws = workbook.addWorksheet('Items Needing Input');

  const noteRow = ws.addRow([
    'Review these items with your accountant. ' +
    'Your answers help determine final deductibility.',
    '', '', '', '', '',
  ]);
  ws.mergeCells(`A1:F1`);
  noteRow.getCell(1).font      = { italic: true, bold: true };
  noteRow.getCell(1).alignment = { wrapText: true };
  noteRow.height = 30;
  ws.addRow([]);

  ws.columns = [
    { header: 'Date',           key: 'date',        width: 14 },
    { header: 'Description',    key: 'description', width: 35 },
    { header: 'Amount',         key: 'amount',       width: 14 },
    { header: 'Category',       key: 'category',     width: 22 },
    { header: 'Question for You', key: 'question',   width: 45 },
    { header: 'Your Answer',    key: 'answer',       width: 35 },
  ];

  styleHeaderRow(ws.getRow(3));

  // Build question lookup by transaction id
  const txQuestionMap = {};
  for (const q of questions) {
    for (const txId of (q.transaction_ids || [])) {
      txQuestionMap[txId] = q;
    }
  }

  const flagged = transactions.filter(t => t.needs_clarification);

  for (const t of flagged) {
    const q = txQuestionMap[t.id];
    const row = ws.addRow({
      date:        t.date,
      description: t.description,
      amount:      parseFloat(t.amount) || 0,
      category:    formatCategory(t.category),
      question:    q?.question || 'Please confirm business purpose.',
      answer:      t.client_response || q?.answer || '',
    });

    row.getCell('amount').numFmt = '$#,##0.00';
    row.getCell('question').alignment = { wrapText: true };
    row.getCell('answer').alignment   = { wrapText: true };
    row.height = 35;

    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOURS.needsReview } };
    });
  }
}

// ── SHEET 5: SUBCONTRACTORS ───────────────────────────────────────────────────

function buildSubcontractorsSheet(workbook, subWarnings) {
  const ws = workbook.addWorksheet('Subcontractors');

  const noteRow = ws.addRow([
    'Anyone paid $600 or more may require a 1099-NEC. ' +
    'Consult your accountant or tax preparer.',
    '', '', '',
  ]);
  ws.mergeCells('A1:D1');
  noteRow.getCell(1).font      = { italic: true, bold: true };
  noteRow.getCell(1).alignment = { wrapText: true };
  noteRow.height = 30;
  ws.addRow([]);

  ws.columns = [
    { header: 'Name / Payee',    key: 'name',          width: 35 },
    { header: 'Total Paid',      key: 'totalPaid',      width: 16 },
    { header: 'Payment Count',   key: 'paymentCount',   width: 16 },
    { header: '1099 Required?',  key: 'requires1099',   width: 16 },
  ];

  styleHeaderRow(ws.getRow(3));

  if (!subWarnings || subWarnings.length === 0) {
    ws.addRow({
      name:         'No subcontractor payments detected',
      totalPaid:    '',
      paymentCount: '',
      requires1099: '',
    });
    return;
  }

  for (const s of subWarnings) {
    const row = ws.addRow({
      name:         s.name,
      totalPaid:    s.totalPaid,
      paymentCount: s.paymentCount,
      requires1099: s.requires_1099 ? 'YES — consult accountant' : 'No',
    });

    row.getCell('totalPaid').numFmt = '$#,##0.00';

    if (s.requires_1099) {
      row.getCell('requires1099').font = { bold: true, color: { argb: 'B71C1C' } };
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOURS.needsReview } };
      });
    }
  }
}

// ── SHARED HELPERS ────────────────────────────────────────────────────────────

function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.fill = {
      type:    'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOURS.headerBg },
    };
    cell.font      = { bold: true, color: { argb: COLOURS.headerText }, size: 11 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border    = {
      bottom: { style: 'thin', color: { argb: '004D40' } },
    };
  });
  row.height = 22;
}

function addMergedTitle(ws, text, rowNum, mergeRange, fontSize, bold) {
  const row = ws.getRow(rowNum);
  row.getCell(1).value     = text;
  row.getCell(1).font      = { size: fontSize, bold };
  row.getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells(mergeRange);
}

function addLabelValue(ws, label, value) {
  const row = ws.addRow([label, value]);
  row.getCell(1).font = { bold: true };
}

function formatCategory(cat) {
  if (!cat) return '—';
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fmt(n) {
  const num = parseFloat(n) || 0;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}