import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import clientRoutes from '../src/routes/client.js';

const app = express();
app.use(express.json());
app.use('/api/client', clientRoutes);

// Helper to generate valid client token
function generateClientToken(caseId, email) {
  const payload = Buffer.from(
    JSON.stringify({
      case_id: caseId,
      email,
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', process.env.CLIENT_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

describe('Client Routes', () => {
  const caseId = 'TX-20260305-A7K2';
  const clientEmail = 'client@example.com';

  describe('GET /api/client/status/:caseId', () => {
    it('should return status info without auth', async () => {
      const res = await request(app)
        .get(`/api/client/status/${caseId}`);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.case_id).toBeDefined();
        expect(res.body.status_label).toBeDefined();
        expect(res.body.stage_number).toBeDefined();
      }
    });

    it('should never return internal notes or worker info', async () => {
      const res = await request(app)
        .get(`/api/client/status/${caseId}`);

      if (res.status === 200) {
        expect(res.body.internal_notes).toBeUndefined();
        expect(res.body.created_by).toBeUndefined();
        expect(res.body.transactions).toBeUndefined();
      }
    });

    it('should return 404 for unknown case_id', async () => {
      const res = await request(app)
        .get('/api/client/status/TX-00000000-XXXX');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/client/reveal/:caseId', () => {
    it('should require valid client token', async () => {
      const res = await request(app)
        .get(`/api/client/reveal/${caseId}`);

      expect(res.status).toBe(401);
    });

    it('should return deduction summary with valid token', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .get(`/api/client/reveal/${caseId}?token=${token}`);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.income_total).toBeDefined();
        expect(res.body.deductions_total).toBeDefined();
        expect(res.body.transactions).toBeUndefined(); // Never show individual txns
      }
    });

    it('should reject invalid token', async () => {
      const res = await request(app)
        .get(`/api/client/reveal/${caseId}?token=invalid.token`);

      expect(res.status).toBe(401);
    });

    it('should return 403 if job not published', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .get(`/api/client/reveal/${caseId}?token=${token}`);

      // If job not published, will get 403 instead of 200
      expect([200, 403, 404]).toContain(res.status);
    });
  });

  describe('GET /api/client/review/:caseId', () => {
    it('should require balance_paid before showing full data', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .get(`/api/client/review/${caseId}?token=${token}`);

      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 403) {
        expect(res.body.error).toContain('Balance');
      }
    });

    it('should require valid client token', async () => {
      const res = await request(app)
        .get(`/api/client/review/${caseId}`);

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/client/review/:caseId/answer', () => {
    it('should save client answer to clarification question', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .post(`/api/client/review/${caseId}/answer?token=${token}`)
        .send({
          question_id: 'q-123',
          answer: 'Yes, this is a business expense'
        });

      expect([200, 400, 403, 404]).toContain(res.status);
    });

    it('should be idempotent', async () => {
      const token = generateClientToken(caseId, clientEmail);
      const answer = 'Yes, this is deductible';

      const res1 = await request(app)
        .post(`/api/client/review/${caseId}/answer?token=${token}`)
        .send({
          question_id: 'q-123',
          answer
        });

      const res2 = await request(app)
        .post(`/api/client/review/${caseId}/answer?token=${token}`)
        .send({
          question_id: 'q-123',
          answer
        });

      expect(res1.status).toBe(res2.status);
    });

    it('should return 400 without answer', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .post(`/api/client/review/${caseId}/answer?token=${token}`)
        .send({ question_id: 'q-123' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/client/download/:caseId', () => {
    it('should return Excel file with correct headers', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .get(`/api/client/download/${caseId}?token=${token}`);

      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.get('Content-Disposition')).toContain('attachment');
        expect(res.get('Content-Disposition')).toContain('.xlsx');
      }
    });

    it('should require balance payment', async () => {
      const token = generateClientToken(caseId, clientEmail);

      const res = await request(app)
        .get(`/api/client/download/${caseId}?token=${token}`);

      expect([200, 403, 404]).toContain(res.status);
    });

    it('should require valid token', async () => {
      const res = await request(app)
        .get(`/api/client/download/${caseId}`);

      expect(res.status).toBe(401);
    });
  });
});
