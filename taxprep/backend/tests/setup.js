import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set required env vars for testing
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.ANTHROPIC_API_KEY = 'test-claude-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_123456789';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123456789';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.CLIENT_TOKEN_SECRET = 'test-secret-32-chars-minimum-here!!';
process.env.FILE_DELETE_AFTER_HOURS = '72';

// Worker credentials
process.env.WORKER_1_NAME = 'Alice';
process.env.WORKER_1_PASSWORD = 'password1';
process.env.WORKER_2_NAME = 'Bob';
process.env.WORKER_2_PASSWORD = 'password2';
process.env.WORKER_3_NAME = 'Charlie';
process.env.WORKER_3_PASSWORD = 'password3';

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      single: jest.fn(),
      upsert: jest.fn().mockReturnThis()
    }))
  }))
}));

// Mock Stripe
jest.mock('stripe', () => {
  return jest.fn(() => ({
    checkout: {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn()
      }
    },
    customers: {
      list: jest.fn(),
      create: jest.fn()
    },
    paymentIntents: {
      retrieve: jest.fn()
    },
    webhooks: {
      constructEvent: jest.fn()
    }
  }));
});

// Mock Claude
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn(() => ({
    messages: {
      create: jest.fn()
    }
  }));
});

// Mock Gemini
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: jest.fn()
  }))
}));

// Helper: Generate worker token (base64 encoded name:password)
export function getWorkerToken(name, password) {
  const credentials = `${name}:${password}`;
  return Buffer.from(credentials).toString('base64');
}

// Helper: Create mock job
export function mockJob(overrides = {}) {
  return {
    id: 'job-123',
    case_id: 'TX-20260305-A7K2',
    status: 'pending',
    tier: 'full',
    client_email: 'client@example.com',
    client_name: 'John Doe',
    company_name: 'John Doe LLC',
    created_by: 'worker_1',
    assigned_to: 'worker_1',
    deposit_paid: false,
    balance_paid: false,
    total_income: 50000,
    total_deductions: 15000,
    balance_amount: 377,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
    sla_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    estimated_completion: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

// Helper: Create mock transaction
export function mockTransaction(overrides = {}) {
  return {
    id: 'tx-123',
    job_id: 'job-123',
    date: '2025-01-15',
    merchant: 'Office Depot',
    amount: 150.00,
    description: 'Office supplies purchase',
    category: 'Office Supplies',
    type: 'expense',
    is_business: true,
    needs_clarification: false,
    confidence: 0.95,
    source_file: 'statement_jan_2025.pdf',
    notes: '',
    created_at: new Date().toISOString(),
    ...overrides
  };
}

// Helper: Create mock clarification question
export function mockClarificationQuestion(overrides = {}) {
  return {
    id: 'q-123',
    job_id: 'job-123',
    transaction_id: 'tx-123',
    question: 'Is this a business expense?',
    answer: null,
    resolved: false,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

// Silence console methods in tests (optional)
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};
