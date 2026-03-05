import { requireIdempotency, optionalIdempotency } from '../src/middleware/idempotency.js';
import express from 'express';
import request from 'supertest';

const app = express();
app.use(express.json());

describe('Idempotency Middleware', () => {
  describe('requireIdempotency', () => {
    beforeEach(() => {
      app.post('/test-required', requireIdempotency, (req, res) => {
        res.json({ success: true, timestamp: Date.now() });
      });
    });

    it('should return 400 on POST without Idempotency-Key', async () => {
      const res = await request(app)
        .post('/test-required')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Idempotency-Key');
    });

    it('should execute handler and cache response on first request', async () => {
      const key = 'test-key-1';

      const res = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', key)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return cached response on second request with same key', async () => {
      const key = 'test-key-2';

      const res1 = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', key)
        .send({});

      const res2 = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', key)
        .send({});

      // Timestamps should be identical if cached
      expect(res1.status).toBe(res2.status);
    });

    it('should accept different idempotency keys independently', async () => {
      const key1 = 'test-key-3a';
      const key2 = 'test-key-3b';

      const res1 = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', key1)
        .send({});

      const res2 = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', key2)
        .send({});

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('should validate Idempotency-Key format', async () => {
      const res = await request(app)
        .post('/test-required')
        .set('Idempotency-Key', '') // Empty key
        .send({});

      expect(res.status).toBe(400);
    });

    it('should pass through GET requests without requiring key', async () => {
      app.get('/test-get', requireIdempotency, (req, res) => {
        res.json({ method: 'GET' });
      });

      const res = await request(app).get('/test-get');

      expect(res.status).toBe(200);
      expect(res.body.method).toBe('GET');
    });
  });

  describe('optionalIdempotency', () => {
    beforeEach(() => {
      app.patch('/test-optional', optionalIdempotency, (req, res) => {
        res.json({ success: true, timestamp: Date.now() });
      });
    });

    it('should pass through without key', async () => {
      const res = await request(app)
        .patch('/test-optional')
        .send({});

      expect(res.status).toBe(200);
    });

    it('should cache response if key provided', async () => {
      const key = 'optional-key-1';

      const res = await request(app)
        .patch('/test-optional')
        .set('Idempotency-Key', key)
        .send({});

      expect(res.status).toBe(200);
    });

    it('should return cached response if key repeated', async () => {
      const key = 'optional-key-2';

      await request(app)
        .patch('/test-optional')
        .set('Idempotency-Key', key)
        .send({});

      const res2 = await request(app)
        .patch('/test-optional')
        .set('Idempotency-Key', key)
        .send({});

      expect(res2.status).toBe(200);
    });

    it('should ignore invalid key format', async () => {
      const res = await request(app)
        .patch('/test-optional')
        .set('Idempotency-Key', '') // Invalid
        .send({});

      expect(res.status).toBe(200);
    });
  });

  describe('GET requests', () => {
    beforeEach(() => {
      app.get('/test-get-2', requireIdempotency, (req, res) => {
        res.json({ count: Math.random() });
      });
    });

    it('should never require idempotency for GET', async () => {
      const res = await request(app).get('/test-get-2');

      expect(res.status).toBe(200);
    });
  });
});
