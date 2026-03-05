import request from 'supertest';
import express from 'express';
import authRoutes from '../src/routes/auth.js';
import { getWorkerToken } from './setup.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

describe('Authentication Routes', () => {
  describe('POST /api/auth/login', () => {
    it('should return token on valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'password1' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.message).toBe('Login successful');
    });

    it('should return 401 on wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 if password missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return worker info with valid token', async () => {
      const token = getWorkerToken('Alice', 'password1');

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
    });

    it('should return 401 with no Authorization header', async () => {
      const res = await request(app)
        .get('/api/auth/me');

      expect(res.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invvalidtoken');

      expect(res.status).toBe(401);
    });
  });
});
