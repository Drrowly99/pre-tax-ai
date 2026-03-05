import request from 'supertest';
import express from 'express';
import adminRoutes from '../src/routes/admin.js';
import { getWorkerToken, mockJob } from './setup.js';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin Routes', () => {
  const token = getWorkerToken('Alice', 'password1');

  describe('GET /api/admin/dashboard', () => {
    it('should return dashboard stats for authenticated worker', async () => {
      const res = await request(app)
        .get('/api/admin/dashboard')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats.total_jobs).toBeGreaterThanOrEqual(0);
      expect(res.body.recent_jobs).toBeInstanceOf(Array);
    });

    it('should return 401 without auth', async () => {
      const res = await request(app)
        .get('/api/admin/dashboard');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/admin/jobs/all', () => {
    it('should return all jobs with pagination', async () => {
      const res = await request(app)
        .get('/api/admin/jobs/all?page=1&limit=20')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.jobs).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();
    });

    it('should filter by status', async () => {
      const res = await request(app)
        .get('/api/admin/jobs/all?status=pending')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.jobs).toBeInstanceOf(Array);
    });

    it('should filter by tier', async () => {
      const res = await request(app)
        .get('/api/admin/jobs/all?tier=full')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /api/admin/jobs/:jobId/assign', () => {
    it('should reassign job to valid worker', async () => {
      const res = await request(app)
        .patch('/api/admin/jobs/job-123/assign')
        .set('Authorization', `Bearer ${token}`)
        .send({ assigned_to: 'worker_2' });

      expect([200, 404]).toContain(res.status);
    });

    it('should reject invalid worker ID', async () => {
      const res = await request(app)
        .patch('/api/admin/jobs/job-123/assign')
        .set('Authorization', `Bearer ${token}`)
        .send({ assigned_to: 'invalid_worker' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/admin/jobs/:jobId/request-docs', () => {
    it('should mark job as needs_more_docs', async () => {
      const res = await request(app)
        .post('/api/admin/jobs/job-123/request-docs')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Please provide Jan and Feb statements' });

      expect([200, 404]).toContain(res.status);
    });

    it('should return 400 if message empty', async () => {
      const res = await request(app)
        .post('/api/admin/jobs/job-123/request-docs')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/admin/jobs/:jobId/audit', () => {
    it('should return audit log for job', async () => {
      const res = await request(app)
        .get('/api/admin/jobs/job-123/audit')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.auditLog).toBeInstanceOf(Array);
    });
  });

  describe('POST /api/admin/jobs/:jobId/audit', () => {
    it('should add manual audit log entry', async () => {
      const res = await request(app)
        .post('/api/admin/jobs/job-123/audit')
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'manual_review', details: { note: 'Reviewed' } });

      expect([200, 404]).toContain(res.status);
    });

    it('should return 400 without action', async () => {
      const res = await request(app)
        .post('/api/admin/jobs/job-123/audit')
        .set('Authorization', `Bearer ${token}`)
        .send({ details: {} });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/admin/jobs/:jobId/files/:fileId', () => {
    it('should delete file from active job', async () => {
      const res = await request(app)
        .delete('/api/admin/jobs/job-123/files/file-123')
        .set('Authorization', `Bearer ${token}`);

      expect([204, 400, 404]).toContain(res.status);
    });
  });

  describe('GET /api/admin/workers', () => {
    it('should return list of workers', async () => {
      const res = await request(app)
        .get('/api/admin/workers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.workers).toBeInstanceOf(Array);
      expect(res.body.workers.length).toBeGreaterThan(0);
    });
  });
});
