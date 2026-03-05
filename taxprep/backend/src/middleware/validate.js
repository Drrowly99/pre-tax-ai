// src/middleware/validate.js
// Request validation middleware factory using Joi.
//
// Usage:
//   import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
//   router.post('/jobs', validateBody(createJobSchema), handler);
//
// On failure: returns 400 with a clear, human-readable error message.
// On success: passes through to next handler.

import Joi from 'joi';
import logger from '../utils/logger.js';

/**
 * Factory — creates an Express middleware that validates req[source]
 * against the provided Joi schema.
 *
 * @param {Joi.Schema} schema
 * @param {'body'|'query'|'params'} source
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,   // collect ALL errors, not just the first
      stripUnknown: true,  // drop unknown fields — prevents field stuffing
      convert: true,       // coerce types (e.g. string '1' → number 1)
    });

    if (error) {
      const messages = error.details.map(d => d.message).join('; ');
      logger.warn('Validation failed', { source, path: req.path, messages });
      return res.status(400).json({ error: messages });
    }

    // Replace with sanitised, coerced values
    req[source] = value;
    next();
  };
}

export const validateBody   = (schema) => validate(schema, 'body');
export const validateQuery  = (schema) => validate(schema, 'query');
export const validateParams = (schema) => validate(schema, 'params');

// ── SHARED SCHEMAS ────────────────────────────────────────────────────────────
// Import these in routes that need them.

export const Schemas = {
  login: Joi.object({
    name:     Joi.string().trim().min(1).max(100).required(),
    password: Joi.string().min(1).max(200).required(),
  }),
};