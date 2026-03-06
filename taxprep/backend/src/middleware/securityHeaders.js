// src/middleware/securityHeaders.js
// Additional security headers beyond helmet.
// Centralises all header logic in one place.

import  logger from '../utils/logger.js';

const SUPABASE_HOST = process.env.SUPABASE_URL
  ? new URL(process.env.SUPABASE_URL).hostname
  : '*.supabase.co';

/**
 * securityHeadersMiddleware
 * Applied globally in server.js after helmet.
 */
function securityHeadersMiddleware(req, res, next) {
  // ── CORS preflight fast-return ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight 24hrs
    return res.status(204).end();
  }

  // ── Content-Security-Policy ─────────────────────────────────────────────
  const csp = [
    "default-src 'self'",
    `connect-src 'self' https://${SUPABASE_HOST} https://api.stripe.com`,
    "script-src 'self' https://js.stripe.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'", // Allow inline styles for now
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);

  // ── Standard security headers ───────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // ── Remove fingerprinting headers ───────────────────────────────────────
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  // ── Custom service header ───────────────────────────────────────────────
  res.setHeader('X-TaxPrep-Version', '1.0');

  // ── Development: log incoming security-relevant headers ─────────────────
  if (process.env.NODE_ENV === 'development') {
    const relevant = [
      'authorization',
      'origin',
      'referer',
      'x-forwarded-for',
      'x-real-ip',
      'idempotency-key',
    ];
    const incoming = {};
    for (const h of relevant) {
      if (req.headers[h]) {
        // Redact auth values — only log presence
        incoming[h] = h === 'authorization' ? '[PRESENT]' : req.headers[h];
      }
    }
    if (Object.keys(incoming).length) {
      logger.debug('Incoming security headers', { path: req.path, headers: incoming });
    }
  }

  next();
}

export default securityHeadersMiddleware;