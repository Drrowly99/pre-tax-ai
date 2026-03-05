-- ============================================================
-- TaxPrep Pro — Supabase Schema
-- Run this entire file in the Supabase SQL editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── JOBS ──────────────────────────────────────────────────────────────────────
-- One row per client tax job. Central table everything connects to.
CREATE TABLE jobs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 TEXT UNIQUE NOT NULL,           -- TX-YYYYMMDD-XXXX

  -- Worker tracking
  created_by              TEXT NOT NULL,                  -- worker_1, worker_2, etc.
  assigned_to             TEXT NOT NULL,

  -- Client info
  client_name             TEXT NOT NULL,
  client_email            TEXT NOT NULL,
  client_phone            TEXT,
  client_whatsapp         TEXT,
  company_name            TEXT NOT NULL,
  bank_account_count      INTEGER DEFAULT 1,

  -- Service
  tier                    TEXT CHECK (tier IN ('single','full','rush')),
  deposit_amount          DECIMAL(10,2) DEFAULT 20.00,
  balance_amount          DECIMAL(10,2),                  -- 277 | 377 | 477
  total_amount            DECIMAL(10,2),                  -- 297 | 397 | 497
  deposit_paid            BOOLEAN DEFAULT false,
  balance_paid            BOOLEAN DEFAULT false,
  stripe_deposit_session  TEXT,
  stripe_balance_session  TEXT,

  -- Status lifecycle
  status                  TEXT DEFAULT 'pending' CHECK (status IN (
                            'pending','documents_received','in_review',
                            'ai_processing','ai_complete','internal_review',
                            'needs_more_docs','published','balance_paid','complete','ai_failed'
                          )),

  -- Timing
  sla_deadline            TIMESTAMPTZ,
  docs_received_at        TIMESTAMPTZ,
  ai_run_at               TIMESTAMPTZ,
  pipeline_started_at     TIMESTAMPTZ,
  pipeline_completed_at   TIMESTAMPTZ,
  published_at            TIMESTAMPTZ,
  gate_shown_at           TIMESTAMPTZ,                    -- when client saw reveal
  created_at              TIMESTAMPTZ DEFAULT NOW(),

  -- AI pipeline progress (for live polling)
  pipeline_progress       INTEGER DEFAULT 0,              -- 0-100
  pipeline_message        TEXT DEFAULT 'Waiting for documents',
  pipeline_error          TEXT,

  -- AI results summary (stored on job for fast reads)
  income_total            DECIMAL(10,2),
  income_1099_total       DECIMAL(10,2),
  deductions_total        DECIMAL(10,2),
  estimated_tax_savings   DECIMAL(10,2),
  transactions_count      INTEGER DEFAULT 0,
  flagged_count           INTEGER DEFAULT 0,

  -- JSONB blobs for complex nested data
  gap_report              JSONB,                          -- gap detection results
  statement_meta          JSONB,                          -- per-file metadata
  financial_summary       JSONB,                          -- full summary breakdown
  subcontractor_warnings  JSONB,                          -- people who may need 1099s

  -- Internal
  internal_notes          TEXT,

  -- Abandonment email tracking (Phase 2)
  balance_reminder_1_sent BOOLEAN DEFAULT false,
  balance_reminder_2_sent BOOLEAN DEFAULT false,
  balance_reminder_3_sent BOOLEAN DEFAULT false
);

-- Indexes for common queries
CREATE INDEX idx_jobs_created_by ON jobs(created_by);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_client_email ON jobs(client_email);

-- ── JOB FILES ─────────────────────────────────────────────────────────────────
-- Tracks each uploaded PDF for a job
CREATE TABLE job_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES jobs(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,                            -- stored filename (timestamped)
  original_name TEXT NOT NULL,                            -- original filename from client
  file_path     TEXT NOT NULL,                            -- absolute path on server
  file_size     INTEGER,                                  -- bytes
  status        TEXT DEFAULT 'uploaded',                  -- uploaded | processed | error
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_job_files_job_id ON job_files(job_id);

-- ── TRANSACTIONS ──────────────────────────────────────────────────────────────
-- One row per transaction extracted from bank statements
CREATE TABLE transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID REFERENCES jobs(id) ON DELETE CASCADE,

  -- Transaction data (from AI extraction)
  date                  DATE NOT NULL,
  description           TEXT NOT NULL,                    -- exact text from statement
  amount                DECIMAL(10,2) NOT NULL,           -- always positive
  type                  TEXT CHECK (type IN ('DEBIT','CREDIT')),

  -- Classification
  tax_category          TEXT NOT NULL,
  is_business           BOOLEAN DEFAULT false,
  confidence            TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  consensus_score       INTEGER CHECK (consensus_score BETWEEN 1 AND 4),

  -- Clarification
  needs_clarification   BOOLEAN DEFAULT false,
  clarification_reason  TEXT,
  client_response       TEXT,                             -- filled in Phase 2
  client_responded_at   TIMESTAMPTZ,

  -- Source tracking
  source_file           TEXT,                             -- which PDF this came from
  account_number_last4  TEXT,

  -- Internal reviewer
  manually_reviewed     BOOLEAN DEFAULT false,
  internal_note         TEXT,

  -- Receipt (Phase 2)
  receipt_url           TEXT,
  receipt_uploaded_at   TIMESTAMPTZ,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transactions_job_id ON transactions(job_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_needs_clarification ON transactions(needs_clarification);

-- ── CLARIFICATION QUESTIONS ───────────────────────────────────────────────────
-- Batched questions sent to client (one per merchant group, not per transaction)
CREATE TABLE clarification_questions (
  id              TEXT PRIMARY KEY,                       -- q_merchant_timestamp
  job_id          UUID REFERENCES jobs(id) ON DELETE CASCADE,

  merchant        TEXT NOT NULL,
  question_text   TEXT NOT NULL,
  question_type   TEXT,                                   -- business_or_personal | cash_usage | subcontractor_1099 | large_transaction
  transaction_ids JSONB,                                  -- array of transaction UUIDs this covers

  total_amount    DECIMAL(10,2),
  occurrences     INTEGER DEFAULT 1,

  -- Client response (Phase 2)
  answer          TEXT,
  resolved        BOOLEAN DEFAULT false,
  answered_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_questions_job_id ON clarification_questions(job_id);
CREATE INDEX idx_questions_resolved ON clarification_questions(resolved);

-- ── AUDIT LOG ────────────────────────────────────────────────────────────────
-- Tracks all sensitive actions (worker edits, publishes, etc.)
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID REFERENCES jobs(id),
  worker_id   TEXT,
  action      TEXT NOT NULL,                              -- 'transaction_edited' | 'job_published' | 'pipeline_triggered'
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_job_id ON audit_log(job_id);

-- ── IDEMPOTENCY KEYS ──────────────────────────────────────────────────────────
-- Caches responses for 24 hours to prevent duplicate operations
CREATE TABLE idempotency_keys (
  id              TEXT PRIMARY KEY,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- ── JOB LOCKS ────────────────────────────────────────────────────────────────
-- Distributed locks to prevent race conditions (TTL: 10 minutes)
CREATE TABLE job_locks (
  job_id          UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  locked_by       TEXT NOT NULL,
  locked_at       TIMESTAMPTZ DEFAULT NOW(),
  operation       TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- SAMPLE DATA — remove before production
-- ============================================================
-- INSERT INTO jobs (case_id, created_by, assigned_to, client_name, client_email,
--   company_name, bank_account_count, tier, balance_amount, total_amount, status)
-- VALUES ('TX-20260305-TEST', 'worker_1', 'worker_1', 'Test Client', 'test@example.com',
--   'Test Landscaping LLC', 1, 'single', 277, 297, 'pending');
