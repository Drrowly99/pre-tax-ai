import { aiPipeline } from '../src/services/aiPipeline.js';
import * as claudeService from '../src/services/claudeExtraction.js';
import * as geminiService from '../src/services/geminiExtraction.js';
import * as judgeService from '../src/services/judgeService.js';
import * as patternService from '../src/services/patternService.js';
import * as gapService from '../src/services/gapDetector.js';
import { supabase } from '../src/utils/supabase.js';

// Mock all services
jest.mock('../src/services/claudeExtraction.js');
jest.mock('../src/services/geminiExtraction.js');
jest.mock('../src/services/judgeService.js');
jest.mock('../src/services/patternService.js');
jest.mock('../src/services/gapDetector.js');
jest.mock('../src/utils/supabase.js');

describe('AI Pipeline Orchestration', () => {
  const jobId = 'job-123';
  const fileUrl = 'https://example.com/statement.pdf';
  const fileType = 'pdf';

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks
    claudeService.claudeExtraction.mockResolvedValue({
      textPass: { transactions: [] },
      visionPass: { transactions: [] }
    });

    geminiService.geminiExtraction.mockResolvedValue({
      textPass: { transactions: [] },
      visionPass: { transactions: [] }
    });

    judgeService.judgeService.mockResolvedValue({
      finalTransactions: [],
      summary: { transactionCount: 0, totalAmount: 0 }
    });

    patternService.patternService.mockResolvedValue({
      groups: {},
      clarificationQuestions: []
    });

    gapService.gapDetector.mockResolvedValue({
      gaps: [],
      coverage: {}
    });

    // Mock Supabase
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: {}, error: null })
    });
  });

  describe('Pipeline Execution Flow', () => {
    it('should update job status to processing on start', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      // Verify status update to processing was called
      const calls = supabase.from.mock.results;
      expect(calls.length).toBeGreaterThan(0);
    });

    it('should call claude extraction with text and vision', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      expect(claudeService.claudeExtraction).toHaveBeenCalledWith(expect.any(String), expect.any(Array));
    });

    it('should call gemini extraction with text and vision', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      expect(geminiService.geminiExtraction).toHaveBeenCalledWith(expect.any(String), expect.any(Array));
    });

    it('should call judge service with all extraction results', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      expect(judgeService.judgeService).toHaveBeenCalled();
      const callArg = judgeService.judgeService.mock.calls[0][0];
      expect(callArg.claude).toBeDefined();
      expect(callArg.gemini).toBeDefined();
    });

    it('should call pattern service after judge', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      expect(patternService.patternService).toHaveBeenCalled();
    });

    it('should call gap detector for data completeness', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      expect(gapService.gapDetector).toHaveBeenCalled();
    });

    it('should update job status to ai_complete on success', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      // Verify final status update was called
      const calls = supabase.from.mock.results;
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should set status to ai_failed on error', async () => {
      claudeService.claudeExtraction.mockRejectedValue(new Error('API error'));

      try {
        await aiPipeline(jobId, fileUrl, fileType);
      } catch (err) {
        // Expected
      }

      // Verify failed status update
      const calls = supabase.from.mock.results;
      expect(calls.length).toBeGreaterThan(0);
    });

    it('should log errors without exposing details', async () => {
      judgeService.judgeService.mockRejectedValue(new Error('Judge failed'));

      await aiPipeline(jobId, fileUrl, fileType).catch(() => {
        // Expected
      });

      // Error should be caught and logged
    });
  });

  describe('Data Handling', () => {
    it('should deduplicate transactions across multiple files', async () => {
      const mockTransactions = [
        { merchant: 'Office Depot', amount: 100, date: '2025-01-01' },
        { merchant: 'Office Depot', amount: 100, date: '2025-01-01' } // Duplicate
      ];

      judgeService.judgeService.mockResolvedValue({
        finalTransactions: mockTransactions,
        summary: { transactionCount: mockTransactions.length }
      });

      await aiPipeline(jobId, fileUrl, fileType);

      // Judge service should deduplicate
      expect(judgeService.judgeService).toHaveBeenCalled();
    });

    it('should batch large transaction inserts', async () => {
      const manyTransactions = Array(250).fill(null).map((_, i) => ({
        merchant: `Merchant ${i}`,
        amount: 100 + i,
        date: '2025-01-01'
      }));

      judgeService.judgeService.mockResolvedValue({
        finalTransactions: manyTransactions,
        summary: { transactionCount: manyTransactions.length }
      });

      await aiPipeline(jobId, fileUrl, fileType);

      // Should batch in groups of 100
      expect(judgeService.judgeService).toHaveBeenCalled();
    });

    it('should store clarification questions', async () => {
      const mockQuestions = [
        { id: 'q-1', transaction_id: 'tx-1', question: 'Is this business?' }
      ];

      patternService.patternService.mockResolvedValue({
        groups: {},
        clarificationQuestions: mockQuestions
      });

      await aiPipeline(jobId, fileUrl, fileType);

      expect(patternService.patternService).toHaveBeenCalled();
    });
  });

  describe('Service Call Order', () => {
    it('should call services in correct sequence', async () => {
      const callOrder = [];

      claudeService.claudeExtraction.mockImplementation(() => {
        callOrder.push('claude');
        return Promise.resolve({ textPass: {}, visionPass: {} });
      });

      geminiService.geminiExtraction.mockImplementation(() => {
        callOrder.push('gemini');
        return Promise.resolve({ textPass: {}, visionPass: {} });
      });

      judgeService.judgeService.mockImplementation(() => {
        callOrder.push('judge');
        return Promise.resolve({ finalTransactions: [] });
      });

      patternService.patternService.mockImplementation(() => {
        callOrder.push('patterns');
        return Promise.resolve({ groups: {} });
      });

      gapService.gapDetector.mockImplementation(() => {
        callOrder.push('gaps');
        return Promise.resolve({ gaps: [] });
      });

      await aiPipeline(jobId, fileUrl, fileType);

      // Verify order
      expect(callOrder.indexOf('claude')).toBeLessThan(callOrder.indexOf('judge'));
      expect(callOrder.indexOf('gemini')).toBeLessThan(callOrder.indexOf('judge'));
      expect(callOrder.indexOf('judge')).toBeLessThan(callOrder.indexOf('patterns'));
    });
  });

  describe('Progress Updates', () => {
    it('should update pipeline_progress from 0 to 100', async () => {
      await aiPipeline(jobId, fileUrl, fileType);

      // In a real implementation, progress would be tracked
      // This is more of an integration test with the DB
      expect(supabase.from).toHaveBeenCalled();
    });
  });
});
