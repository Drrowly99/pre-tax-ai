// src/utils/asyncHandler.js
// ESM-native replacement for express-async-errors.
//
// express-async-errors is CommonJS-only and cannot be imported in an ESM
// project. This utility does the same job: wraps an async route handler
// so any rejected promise is forwarded to Express's error handler via next().
//
// Usage:
//   import asyncHandler from '../utils/asyncHandler.js';
//   router.get('/foo', asyncHandler(async (req, res) => {
//     const data = await someAsyncThing();
//     res.json({ data });
//   }));

/**
 * Wraps an async Express route handler and forwards any thrown error
 * to the next() error handler — no try/catch needed in route files.
 *
 * @param {Function} fn  async (req, res, next) => void
 * @returns {Function}   standard Express middleware
 */
export default function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}