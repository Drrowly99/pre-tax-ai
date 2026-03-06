// src/services/aiPipeline.js
// THE BRAIN — orchestrates the entire AI processing pipeline for a job.
// Called when a worker clicks "Run AI Analysis" on a job.
//
// PIPELINE ORDER:
// 1. Pre-process all uploaded PDFs (text + images)
// 2. Gap detection (are any months missing?)
// 3. For each PDF: run 4 AI extractions in parallel
//    → Claude text, Claude vision, Gemini text, Gemini vision
// 4. For each PDF: Judge reconciles 4 outputs → master transaction list
// 5. Math verification (opening + credits - debits = closing?)
// 6. Merge all PDFs into one combined transaction list (multi-account jobs)
// 7. Pattern grouping + recurring merchant detection
// 8. Generate batched clarification questions
// 9. Calculate financial summary (income, deductions, savings estimate)
// 10. Save everything to Supabase
// 11. Update job status to 'ai_complete'

import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';
import { processPDF } from './pdfProcessor.js';
import { analyseGaps } from './gapDetector.js';
// import { extractFromText as claudeText, extractFromVision as claudeVision } from './claudeExtraction.js';
import { extractFromText as geminiText, extractFromVision as geminiVision } from './geminiExtraction.js';
import { runJudge } from './judgeService.js';
import { analysePatterns } from './patternService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Run the full AI pipeline for a job.
 * This is designed to run in the background — caller does NOT await this.
 * Progress is written to the jobs table so the frontend can poll it.
 *
 * @param {string} jobId - The job UUID
 * @param {Array} uploadedFiles - [{ path, filename, originalname }]
 */
async function runPipeline(jobId, uploadedFiles) {
  logger.info('AI pipeline started', { jobId, fileCount: uploadedFiles.length });

  try {
    // ── STATUS: processing started ───────────────────────────────────────────
    await updateJobStatus(jobId, 'ai_processing', { pipeline_started_at: new Date().toISOString() });

    // ── STEP 1: PRE-PROCESS ALL PDFS ─────────────────────────────────────────
    await setProgress(jobId, 'Reading and preparing your documents…', 5);

    const processed = [];
    for (const file of uploadedFiles) {
      const result = await processPDF(file.path, file.originalname);
      processed.push({ ...file, ...result });
    }

    // ── STEP 2: GAP DETECTION ─────────────────────────────────────────────────
    await setProgress(jobId, 'Checking for missing months…', 15);

    const dateRanges = processed
      .map(f => f.dateRange)
      .filter(r => r.start_date || r.end_date);

    const gapReport = analyseGaps(dateRanges);

    await supabase
      .from('jobs')
      .update({ gap_report: gapReport })
      .eq('id', jobId);

    logger.info('Gap analysis saved', { jobId, hasGaps: gapReport.has_gaps });

    // ── STEP 3+4: 4-AI EXTRACTION + JUDGE PER PDF ────────────────────────────
    await setProgress(jobId, 'Our team is reviewing your bank statements…', 25);

    const allJudgedTransactions = [];
    const statementMeta = [];
    let fileIndex = 0;

    for (const file of processed) {
      fileIndex++;
      const progressBase = 25 + (fileIndex / processed.length) * 45; // 25–70%
      await setProgress(jobId, `Analysing statement ${fileIndex} of ${processed.length}…`, progressBase);

      logger.info('Running 4-model extraction', { jobId, filename: file.originalname });

      // Run all 4 models in parallel
      const [claudeTextResult, claudeVisionResult, geminiTextResult, geminiVisionResult] =
        await Promise.all([
          claudeText(file.text, file.originalname),
          claudeVision(file.pageImages, file.originalname),
          geminiText(file.text, file.originalname),
          geminiVision(file.pageImages, file.originalname),
        ]);

      logger.info('All 4 extractions complete', {
        jobId,
        filename: file.originalname,
        counts: [
          claudeTextResult.transactions?.length,
          claudeVisionResult.transactions?.length,
          geminiTextResult.transactions?.length,
          geminiVisionResult.transactions?.length,
        ],
      });

      // ── STEP 4: JUDGE ──────────────────────────────────────────────────────
      await setProgress(jobId, `Reconciling statement ${fileIndex}…`, progressBase + 5);

      const judged = await runJudge(
        [claudeTextResult, claudeVisionResult, geminiTextResult, geminiVisionResult],
        file.originalname
      );

      // Tag each transaction with which account/file it came from
      const taggedTransactions = (judged.transactions || []).map(t => ({
        ...t,
        id: uuidv4(),
        job_id: jobId,
        source_file: file.originalname,
        account_number_last4: judged.account_number_last4 || null,
      }));

      allJudgedTransactions.push(...taggedTransactions);

      statementMeta.push({
        filename: file.originalname,
        statement_period_start: judged.statement_period_start,
        statement_period_end: judged.statement_period_end,
        opening_balance: judged.opening_balance,
        closing_balance: judged.closing_balance,
        math_closed: judged.math_closed,
        math_discrepancy: judged.math_discrepancy,
        missing_transaction_flag: judged.missing_transaction_flag,
        transaction_count: taggedTransactions.length,
      });
    }

    // ── STEP 5: MERGE + DEDUP ─────────────────────────────────────────────────
    await setProgress(jobId, 'Combining all accounts…', 72);

    // Remove obvious duplicates (same date + description + amount across files)
    const deduped = deduplicateTransactions(allJudgedTransactions);

    logger.info('Transactions merged', {
      jobId,
      beforeDedup: allJudgedTransactions.length,
      afterDedup: deduped.length,
    });

    // ── STEP 6+7: PATTERN GROUPING + CLARIFICATION QUESTIONS ─────────────────
    await setProgress(jobId, 'Identifying patterns and preparing your questions…', 80);

    const { transactions, clarification_questions, summary, subcontractor_warnings } =
      analysePatterns(deduped);

    // ── STEP 8: SAVE TRANSACTIONS TO SUPABASE ─────────────────────────────────
    await setProgress(jobId, 'Saving results…', 90);

    // Insert transactions in batches of 100
    for (let i = 0; i < transactions.length; i += 100) {
      const batch = transactions.slice(i, i + 100);
      const { error } = await supabase.from('transactions').insert(batch);
      if (error) {
        logger.error('Transaction batch insert failed', { jobId, batchStart: i, error: error.message });
        throw error;
      }
    }

    // Save clarification questions
    if (clarification_questions.length > 0) {
      const questionsWithJobId = clarification_questions.map(q => ({
        ...q,
        job_id: jobId,
      }));
      const { error } = await supabase.from('clarification_questions').insert(questionsWithJobId);
      if (error) {
        logger.error('Questions insert failed', { jobId, error: error.message });
      }
    }

    // ── STEP 9: UPDATE JOB WITH SUMMARY ──────────────────────────────────────
    const { error: jobError } = await supabase
      .from('jobs')
      .update({
        status: 'ai_complete',
        pipeline_completed_at: new Date().toISOString(),
        income_total: summary.total_income,
        income_1099_total: summary.total_income_1099,
        deductions_total: summary.total_deductions,
        estimated_tax_savings: summary.estimated_tax_savings,
        transactions_count: transactions.length,
        flagged_count: summary.flagged_count,
        statement_meta: statementMeta,
        gap_report: gapReport,
        subcontractor_warnings: subcontractor_warnings,
        financial_summary: summary,
        pipeline_progress: 100,
        pipeline_message: 'Analysis complete — ready for internal review',
      })
      .eq('id', jobId);

    if (jobError) throw jobError;

    logger.info('AI pipeline completed successfully', {
      jobId,
      transactions: transactions.length,
      questions: clarification_questions.length,
      income: summary.total_income,
      deductions: summary.total_deductions,
      savings: summary.estimated_tax_savings,
    });

  } catch (err) {
    logger.error('AI pipeline FAILED', { jobId, error: err.message, stack: err.stack });

    await supabase
      .from('jobs')
      .update({
        status: 'ai_failed',
        pipeline_error: err.message,
        pipeline_message: 'Analysis failed — please check documents and retry',
        pipeline_progress: 0,
      })
      .eq('id', jobId);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function updateJobStatus(jobId, status, extra = {}) {
  const { error } = await supabase
    .from('jobs')
    .update({ status, ...extra })
    .eq('id', jobId);

  if (error) logger.error('Status update failed', { jobId, status, error: error.message });
}

async function setProgress(jobId, message, percent) {
  logger.info(`Pipeline progress: ${percent}%`, { jobId, message });
  await supabase
    .from('jobs')
    .update({
      pipeline_progress: Math.round(percent),
      pipeline_message: message,
    })
    .eq('id', jobId);
}

function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(t => {
    // Key: date + amount + type + first 20 chars of description
    const key = `${t.date}_${t.amount}_${t.type}_${(t.description || '').slice(0, 20).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { runPipeline };