// src/utils/logger.js
// Structured logger. Never log PII — use logger.safe() for anything
// that might contain names, emails, or financial data.

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level) {
  return LEVELS[level] >= (LEVELS[LOG_LEVEL] ?? 1);
}

function format(level, message, meta = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

const logger = {
  debug(message, meta) {
    if (shouldLog('debug')) console.debug(format('debug', message, meta));
  },

  info(message, meta) {
    if (shouldLog('info')) console.info(format('info', message, meta));
  },

  warn(message, meta) {
    if (shouldLog('warn')) console.warn(format('warn', message, meta));
  },

  error(message, meta) {
    if (shouldLog('error')) console.error(format('error', message, meta));
  },

  // Use this for anything that MIGHT contain PII.
  // Strips known sensitive keys before logging.
  safe(level, message, meta = {}) {
    const REDACTED_KEYS = new Set([
      'email', 'name', 'password', 'phone', 'ssn', 'ein',
      'amount', 'income', 'deductions', 'savings',
      'client_name', 'company_name', 'client_email',
    ]);

    const clean = Object.fromEntries(
      Object.entries(meta).map(([k, v]) =>
        REDACTED_KEYS.has(k.toLowerCase()) ? [k, '[REDACTED]'] : [k, v]
      )
    );

    this[level]?.(message, clean);
  },
};

export default logger;