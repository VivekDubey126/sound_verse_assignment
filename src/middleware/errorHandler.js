const { AppError, formatError, RateLimitError } = require('../utils/errors');

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err instanceof RateLimitError && err.retryAfterSec) {
      res.setHeader('Retry-After', String(err.retryAfterSec));
    }
    return res.status(err.statusCode).json(formatError(err, req.requestId || 'unknown'));
  }

  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'internal_error',
      message: err.message || 'Internal server error',
      request_id: req.requestId || 'unknown',
    },
  });
}

module.exports = { errorHandler };

