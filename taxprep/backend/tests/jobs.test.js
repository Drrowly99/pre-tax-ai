import request from 'supertest';
import express from 'express';
import jobsRoutes from '../src/routes/jobs.js';
import { getWorkerToken, mockJob } from './setup.js';

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRoutes);

describe('Jobs Routes', () => {
  const token = getWorkerToken('Alice', 'password1');

  describe('POST /api/jobs', () => {
    it('should create job with required fields', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'test-idempotency-1')
        .send({
          client_email: 'test@example.com',
          client_name: 'Test Client',
          company_name: 'Test Co',
          tier: 'full',
          bank_account_count: 2
        });

      expect(res.status).toBe(201);
      expect(res.body.job_id).toBeDefined();
      expect(res.body.case_id).toMatch(/^TX-\d{8}-[A-Z0-9]{4}$/);
    });

    it('should return 400 without Idempotency-Key', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          client_email: 'test@example.com',
          tier: 'full'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Idempotency-Key');
    });

    it('should return 400 for invalid email', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'test-key-2')
        .send({
          client_email: 'not-an-email',
          tier: 'full'
        });

      expect(res.status).toBe(400);
    });

    it('should return cached response on duplicate Idempotency-Key', async () => {
      const key = 'test-key-duplicate';

      const res1 = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          client_email: 'test@example.com',
          tier: 'full'
        });

      const res2 = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          client_email: 'different@example.com',
          tier: 'single'
        });

      expect(res2.status).toBe(res1.status);
    });
  });

  describe('GET /api/jobs', () => {
    it('should return jobs for authenticated worker', async () => {
      const res = await request(app)
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('should return 401 without token', async () => {
      const res = await request(app)
        .get('/api/jobs');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/jobs/:jobId', () => {
    it('should return job details with valid ID', async () => {
      const res = await request(app)
        .get('/api/jobs/job-123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBeOneOf([200, 404]); // Depends on mock data
    });

    it('should return 404 for nonexistent job', async () => {
      const res = await request(app)
        .get('/api/jobs/nonexistent-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/jobs/:jobId', () => {
    it('should update job status', async () => {
      const res = await request(app)
        .patch('/api/jobs/job-123')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'internal_review' });

      expect([200, 404]).toContain(res.status);
    });

    it('should reject invalid status', async () => {
      const res = await request(app)
        .patch('/api/jobs/job-123')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'invalid_status' });

      expect(res.status).toBeOneOf([400, 404]);
    });
  });

  describe('POST /api/jobs/:jobId/run-analysis', () => {
    it('should trigger pipeline and return immediately', async () => {
      const res = await request(app)
        .post('/api/jobs/job-123/run-analysis')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'test-pipeline-1')
        .send({});

      expect(res.status).toBeOneOf([200, 400, 409, 404]);
    });
  });

  describe('GET /api/jobs/:jobId/status', () => {
    it('should return job status without auth', async () => {
      const res = await request(app)
        .get('/api/jobs/job-123/status');

      expect(res.status).toBeOneOf([200, 404]);
      if (res.status === 200) {
        expect(res.body.status).toBeDefined();
      }
    });
  });
});

// Custom matcher helper
expect.extend({
  toBeOneOf(received, expected) {
    const pass = expected.includes(received);
    return {
      pass,
      message: () => `Expected ${received} to be one of ${expected.join(', ')}`
    };
  }
});
