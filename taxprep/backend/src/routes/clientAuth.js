// src/routes/clientAuth.js
// Client authentication routes using Supabase

import { Router } from 'express';
import { validateBody, Schemas } from '../middleware/validate.js';
import { requireClientAuth } from '../middleware/clientAuth.js';
import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = Router();

// Validation schema for client login
const clientLoginSchema = Joi.object({
  email: Joi.string().email().trim(),
  password: Joi.string(),
  provider: Joi.string().valid('google'),
  providerToken: Joi.string()
}).or('email', 'providerToken');

// Validation schema for client registration
const clientRegisterSchema = Joi.object({
  email: Joi.string().email().trim().required(),
  password: Joi.string().min(6).required(),
});

// ── POST /api/auth/client/register ────────────────────────────────────────────
// Register a new external user using Supabase
router.post('/register', validateBody(clientRegisterSchema), async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      logger.warn('Failed client registration', { email, error: error.message });
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      data: {
        user: data.user,
        session: data.session,
      },
      message: 'Registration successful',
    });
  } catch (err) {
    logger.error('Client registration error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/client/login ───────────────────────────────────────────────
// Authenticate an external user (returns Supabase session)
router.post('/login', validateBody(clientLoginSchema), async (req, res) => {
  const { email, password, provider, providerToken } = req.body;

  try {
    if (provider === 'google' && providerToken) {
      const { data, error } = await supabase.auth.getUser(providerToken);
      if (error || !data?.user) {
        logger.warn('Failed client Google login', { ip: req.ip, error: error?.message });
        return res.status(401).json({ error: 'Invalid Google token.' });
      }
      return res.status(200).json({
        data: {
          user: data.user,
          // When logging in with just a provider token on backend, 
          // usually the token itself is the access token from frontend's Supabase client.
          token: providerToken 
        }
      });
    } else if (email && password) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data?.user) {
        logger.warn('Failed client email login', { ip: req.ip, email, error: error?.message });
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      
      return res.status(200).json({
        data: {
          user: data.user,
          session: data.session,
          token: data.session.access_token
        }
      });
    } else {
      return res.status(400).json({ error: 'Missing credentials.' });
    }
  } catch (err) {
    logger.error('Client login error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/client/me ───────────────────────────────────────────────────
// Get current authenticated client profile
router.get('/me', requireClientAuth, (req, res) => {
  return res.status(200).json({
    data: {
      user: req.user,
    },
  });
});

export default router;
