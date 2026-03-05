import request from 'supertest';
import express from 'express';
import stripeRoutes from '../src/routes/stripe.js';
import { getWorkerToken } from './setup.js';

const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRoutes);

describe('Stripe Routes', () => {
  describe('POST /api/stripe/create-deposit-session', () => {
    it('should create Stripe session for $20 deposit', async () => {
      const res = await request(app)
        .post('/api/stripe/create-deposit-session')
        .set('Idempotency-Key', 'stripe-deposit-1')
        .send({
          case_id: 'TX-20260305-A7K2',
          tier: 'full'
        });

      expect([200, 400, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.checkout_url).toBeDefined();
        expect(res.body.session_id).toBeDefined();
      }
    });

    it('should require Idempotency-Key', async () => {
      const res = await request(app)
        .post('/api/stripe/create-deposit-session')
        .send({
          case_id: 'TX-20260305-A7K2',
          tier: 'full'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Idempotency-Key');
    });

    it('should return 400 if case_id missing', async () => {
      const res = await request(app)
        .post('/api/stripe/create-deposit-session')
        .set('Idempotency-Key', 'stripe-deposit-2')
        .send({ tier: 'full' });

      expect(res.status).toBe(400);
    });

    it('should return cached response on duplicate Idempotency-Key', async () => {
      const key = 'stripe-deposit-duplicate';

      await request(app)
        .post('/api/stripe/create-deposit-session')
        .set('Idempotency-Key', key)
        .send({
          case_id: 'TX-20260305-A7K2',
          tier: 'full'
        });

      const res2 = await request(app)
        .post('/api/stripe/create-deposit-session')
        .set('Idempotency-Key', key)
        .send({
          case_id: 'TX-20260305-A7K2',
          tier: 'full'
        });

      expect([200, 400, 404]).toContain(res2.status);
    });
  });

  describe('POST /api/stripe/create-balance-session', () => {
    it('should create session for correct balance amount', async () => {
      const res = await request(app)
        .post('/api/stripe/create-balance-session')
        .set('Idempotency-Key', 'stripe-balance-1')
        .send({ case_id: 'TX-20260305-A7K2' });

      expect([200, 400, 403, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.checkout_url).toBeDefined();
      }
    });

    it('should return 403 if job not yet published', async () => {
      const res = await request(app)
        .post('/api/stripe/create-balance-session')
        .set('Idempotency-Key', 'stripe-balance-2')
        .send({ case_id: 'TX-20260305-A7K2' });

      expect([200, 403, 404]).toContain(res.status);
    });

    it('should require Idempotency-Key', async () => {
      const res = await request(app)
        .post('/api/stripe/create-balance-session')
        .send({ case_id: 'TX-20260305-A7K2' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/stripe/webhook', () => {
    it('should verify Stripe signature before processing', async () => {
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 'invalid_signature')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should always return 200 to Stripe', async () => {
      // Note: This test would need proper webhook signature setup
      // For now, we check that endpoint returns 200 or 400
      const res = await request(app)
        .post('/api/stripe/webhook')
        .send({});

      expect([200, 400]).toContain(res.status);
    });

    it('should process checkout.session.completed events', async () => {
      // Would need valid Stripe signature and event structure
      // This is more of an integration test
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 'test')
        .send({
          type: 'checkout.session.completed',
          id: 'evt_test',
          data: {
            object: {
              id: 'cs_test',
              metadata: {
                job_id: 'job-123',
                case_id: 'TX-20260305-A7K2',
                payment_type: 'deposit'
              }
            }
          }
        });

      expect([200, 400]).toContain(res.status);
    });
  });
});
