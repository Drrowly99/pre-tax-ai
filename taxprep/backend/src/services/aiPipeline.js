// src/services/aiPipeline.js
// Orchestrates the 3-agent pipeline:
//   Agent 1 (Extractor)    → raw data out, math verified, anchor chain retry
//   Agent 2 (Categoriser)  → classify every transaction, Google search unknowns
//   Agent 3 (Judge)        → validate, send problems back to Agent 2, finalise
// All intermediate outputs saved to backend/logs/extractions/ as timestamped JSON.

import { v4 as uuidv4 }           from 'uuid';
import supabase                    from '../utils/supabase.js';
import logger                      from '../utils/logger.js';
import { processPDF }              from './pdfProcessor.js';
import { analyseGaps }             from './gapDetector.js';
import { analysePatterns }         from './patternService.js';
import { runExtractorAgent }       from './agents/extractorAgent.js';
import { runCategoriserAgent }     from './agents/categoriserAgent.js';
import { runJudgeAgent }           from './agents/judgeAgent.js';

export async function runPipeline(jobId, uploadedFiles) {
  logger.info('AI pipeline started', { jobId, fileCount: uploadedFiles.length });

  try {
    // ── STARTED ──────────────────────────────────────────────────────────────
    await updateJob(jobId, {
      status:              'ai_processing',
      pipeline_started_at: new Date().toISOString(),
      pipeline_progress:   0,
      pipeline_message:    'Starting analysis…',
    });

    // ── STEP 1: VALIDATE FILES ────────────────────────────────────────────────
    await setProgress(jobId, 'Reading and preparing your documents…', 5);

    const processed = [];
    for (const file of uploadedFiles) {
      const result = await processPDF(file.path, file.originalname);
      processed.push({ ...file, ...result });
    }

    // ── STEP 2: 3-AGENT PIPELINE PER PDF ─────────────────────────────────────
    await setProgress(jobId, 'Our team is reviewing your bank statements…', 10);

    const allFinalTransactions = [];
    const statementMeta        = [];
    const extractedDateRanges  = [];
    let   fileIndex             = 0;

    for (const file of processed) {
      fileIndex++;

      // ── AGENT 1: EXTRACTOR ──────────────────────────────────────────────
      await setProgress(
        jobId,
        `[${fileIndex}/${processed.length}] Extracting transactions from statement…`,
        10 + (fileIndex / processed.length) * 25
      );

      const rawResult = await runExtractorAgent(file.filePath, file.originalname, jobId);

      logger.info('Agent 1 complete', {
        jobId,
        filename:         file.originalname,
        transactionCount: rawResult.transactions?.length ?? 0,
        mathFailed:       rawResult.math_failed ?? false,
      });

      // Collect dates from Agent 1 for gap detection
      if (rawResult.statement_period_start || rawResult.statement_period_end) {
        extractedDateRanges.push({
          start_date: rawResult.statement_period_start,
          end_date:   rawResult.statement_period_end,
        });
      }

      // ── AGENT 2: CATEGORISER ────────────────────────────────────────────
      await setProgress(
        jobId,
        `[${fileIndex}/${processed.length}] Categorising and identifying transactions…`,
        35 + (fileIndex / processed.length) * 25
      );

      const categorisedResult = await runCategoriserAgent(rawResult, file.originalname, jobId);

      logger.info('Agent 2 complete', {
        jobId,
        filename:     file.originalname,
        unknown:      categorisedResult.transactions?.filter(t => t.category === 'unknown').length ?? 0,
        searched:     categorisedResult.transactions?.filter(t => t.search_attempted).length ?? 0,
      });

      // ── AGENT 3: JUDGE ──────────────────────────────────────────────────
      await setProgress(
        jobId,
        `[${fileIndex}/${processed.length}] Validating and finalising…`,
        60 + (fileIndex / processed.length) * 15
      );

      const judgedResult = await runJudgeAgent(categorisedResult, file.originalname, jobId);

      logger.info('Agent 3 complete', {
        jobId,
        filename:      file.originalname,
        finalCount:    judgedResult.transactions?.length ?? 0,
        mathClosed:    judgedResult.math_closed,
        discrepancy:   judgedResult.math_discrepancy,
      });

      // ── TAG + COLLECT ───────────────────────────────────────────────────
      const tagged = (judgedResult.transactions || []).map(t => ({
        // Core fields for Supabase
        id:                   uuidv4(),
        job_id:               jobId,
        date:                 t.date,
        description:          t.description,
        amount:               t.amount,
        type:                 t.type,
        category:             t.category    || 'unknown',
        is_business:          t.is_business ?? null,
        confidence:           t.confidence  || 'LOW',
        consensus_score:      1,
        needs_clarification:  t.needs_clarification ?? false,
        notes:                buildNotes(t),
        source_file:          file.originalname,
        account_number_last4: judgedResult.account_number_last4 || null,
        merchant_normalised:  t.description,
        // Extra fields for worker visibility
        ...(t.search_result   ? { internal_note: `Search result: ${t.search_result}` } : {}),
        ...(t.judge_flag      ? { internal_note: `Judge flag: ${t.judge_flag}` } : {}),
      }));

      allFinalTransactions.push(...tagged);

      statementMeta.push({
        filename:                 file.originalname,
        statement_period_start:   judgedResult.statement_period_start,
        statement_period_end:     judgedResult.statement_period_end,
        opening_balance:          judgedResult.opening_balance,
        closing_balance:          judgedResult.closing_balance,
        math_closed:              judgedResult.math_closed,
        math_discrepancy:         judgedResult.math_discrepancy,
        missing_transaction_flag: judgedResult.missing_transaction_flag,
        transaction_count:        tagged.length,
        math_failed:              rawResult.math_failed ?? false,
        judge_notes:              judgedResult.judge_notes ?? [],
        subcontractor_warnings:   judgedResult.subcontractor_warnings ?? [],
      });
    }

    // ── STEP 3: GAP DETECTION ────────────────────────────────────────────────
    await setProgress(jobId, 'Checking for missing months…', 76);

    const gapReport = analyseGaps(extractedDateRanges);
    await updateJob(jobId, { gap_report: gapReport });

    if (extractedDateRanges.length === 0) {
      logger.warn('Gap detection skipped — no statement dates returned', { jobId });
    } else {
      logger.info('Gap analysis saved', { jobId, hasGaps: gapReport.has_gaps });
    }

    // ── STEP 4: DEDUPLICATE ───────────────────────────────────────────────────
    await setProgress(jobId, 'Combining all accounts…', 80);

    const deduped = deduplicateTransactions(allFinalTransactions);

    logger.info('Transactions merged', {
      jobId,
      beforeDedup: allFinalTransactions.length,
      afterDedup:  deduped.length,
    });

    // ── STEP 5: PATTERN ANALYSIS ─────────────────────────────────────────────
    await setProgress(jobId, 'Identifying patterns and preparing your questions…', 86);

    const {
      transactions,
      clarification_questions,
      summary,
      subcontractor_warnings,
    } = analysePatterns(deduped);

    // ── STEP 6: SAVE ──────────────────────────────────────────────────────────
    await setProgress(jobId, 'Saving results…', 93);

    for (let i = 0; i < transactions.length; i += 100) {
      const batch = transactions.slice(i, i + 100);
      const { error } = await supabase.from('transactions').insert(batch);
      if (error) {
        logger.error('Transaction batch insert failed', { jobId, batchStart: i, error: error.message });
        throw error;
      }
    }

    if (clarification_questions.length > 0) {
      const withJobId = clarification_questions.map(q => ({ ...q, job_id: jobId }));
      const { error } = await supabase.from('clarification_questions').insert(withJobId);
      if (error) logger.error('Questions insert failed', { jobId, error: error.message });
    }

    // ── STEP 7: FINALISE ─────────────────────────────────────────────────────
    await updateJob(jobId, {
      status:                 'ai_complete',
      pipeline_completed_at:  new Date().toISOString(),
      pipeline_progress:      100,
      pipeline_message:       'Analysis complete — ready for internal review',
      pipeline_error:         null,
      income_total:           summary.total_income,
      income_1099_total:      summary.total_income_1099,
      deductions_total:       summary.total_deductions,
      estimated_tax_savings:  summary.estimated_tax_savings,
      transactions_count:     transactions.length,
      flagged_count:          summary.flagged_count,
      statement_meta:         statementMeta,
      gap_report:             gapReport,
      subcontractor_warnings,
      financial_summary:      summary,
    });

    logger.info('AI pipeline completed successfully', {
      jobId,
      transactions: transactions.length,
      questions:    clarification_questions.length,
      income:       summary.total_income,
      deductions:   summary.total_deductions,
      savings:      summary.estimated_tax_savings,
    });

  } catch (err) {
    logger.error('Pipeline FAILED', { jobId, error: err.message, stack: err.stack });
    await updateJob(jobId, {
      status:            'ai_failed',
      pipeline_error:    err.message,
      pipeline_message:  'Analysis failed — please check documents and retry',
      pipeline_progress: 0,
    });
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function updateJob(jobId, fields) {
  const { error } = await supabase.from('jobs').update(fields).eq('id', jobId);
  if (error) logger.error('Job update failed', { jobId, error: error.message });
}

async function setProgress(jobId, message, percent) {
  logger.info(message, { jobId });
  await updateJob(jobId, { pipeline_progress: Math.round(percent), pipeline_message: message });
}

function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(t => {
    const key = `${t.date}_${t.amount}_${t.type}_${(t.description || '').slice(0, 20).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the notes field for a transaction combining all agent notes.
 */
function buildNotes(t) {
  const parts = [];
  if (t.reasoning)   parts.push(`Classification: ${t.reasoning}`);
  if (t.notes)       parts.push(t.notes);
  if (t.judge_flag)  parts.push(`⚑ Judge: ${t.judge_flag}`);
  if (t.search_result) parts.push(`🔍 Search: ${t.search_result.slice(0, 200)}`);
  return parts.length ? parts.join(' | ') : null;
}