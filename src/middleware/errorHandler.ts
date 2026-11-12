import { Request, Response, NextFunction } from 'express';
import { AppError, formatError, RateLimitError } from '../utils/errors';

/**
 * Global error handler — catches AppError instances and unknown errors,
 * and returns the standard error shape.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const body = formatError(err, req.requestId || 'unknown');

    if (err instanceof RateLimitError && err.retryAfterSec) {
      res.setHeader('Retry-After', String(err.retryAfterSec));
    }

    res.status(err.statusCode).json(body);
    return;
  }

  // Unknown error
  console.error('[ERROR]', err);
  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'internal_error',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      request_id: req.requestId || 'unknown',
    },
  });
}

