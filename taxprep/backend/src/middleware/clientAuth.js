// src/middleware/clientAuth.js
// Client authentication middleware for external users using Supabase.
//
// Expects Header format: Authorization: Bearer <supabase_jwt>
// Validates the JWT directly using Supabase Auth.

import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

/**
 * Express middleware — protects any route that requires a logged-in client.
 * Attaches req.user on success.
 */
export async function requireClientAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token.' });
  }

  const token = authHeader.slice(7).trim();

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn('Unauthorized client access attempt', {
        path: req.path,
        method: req.method,
        ip: req.ip,
        error: error?.message,
      });
      return res.status(401).json({
        error: 'Unauthorized. Invalid token.',
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
    };

    next();
  } catch (err) {
    logger.error('Client auth middleware error', { error: err.message });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
