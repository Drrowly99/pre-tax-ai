import logger from '../utils/logger.js';

/**
 * Security Headers Middleware
 * Centralizes all security header configuration
 */

export function securityHeadersMiddleware(req, res, next) {
  // Content Security Policy — strict whitelist
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' https://js.stripe.com`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: https:`,
      `font-src 'self' data:`,
      `connect-src 'self' https://api.stripe.com https://*.supabase.co`,
      `frame-src https://js.stripe.com`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Frame options — prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy (formerly Feature-Policy)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Custom header for version tracking
  res.setHeader('X-TaxPrep-Version', '1.0');

  // Ensure X-Powered-By is removed
  res.removeHeader('X-Powered-By');

  // Log security headers in development
  if (process.env.NODE_ENV === 'development') {
    const securityRelevantHeaders = [
      'authorization',
      'x-api-key',
      'x-stripe-signature',
      'idempotency-key',
      'user-agent'
    ];

    const loggedHeaders = {};
    securityRelevantHeaders.forEach(header => {
      const value = req.get(header);
      if (value) {
        // Don't log full auth values
        if (header === 'authorization') {
          loggedHeaders[header] = value.substring(0, 20) + '...';
        } else {
          loggedHeaders[header] = value;
        }
      }
    });

    if (Object.keys(loggedHeaders).length > 0) {
      logger.debug(`Security headers in request:`, loggedHeaders);
    }
  }

  next();
}

/**
 * CORS preflight fast-return middleware
 * Handles OPTIONS requests with 204 No Content
 */
export function corsPreflightHandler(req, res, next) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}

export default securityHeadersMiddleware;
