class AppError extends Error {
  constructor(statusCode, type, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
  }
}

class BadRequestError extends AppError {
  constructor(code, message) {
    super(400, 'invalid_request_error', code, message);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Invalid or missing API key') {
    super(401, 'authentication_error', 'invalid_api_key', message);
  }
}

class ForbiddenError extends AppError {
  constructor(code, message) {
    super(403, 'forbidden_error', code, message);
  }
}

class NotFoundError extends AppError {
  constructor(resource) {
    super(404, 'not_found_error', 'resource_not_found', `${resource} not found`);
  }
}

class ConflictError extends AppError {
  constructor(code, message) {
    super(409, 'conflict_error', code, message);
  }
}

class UnprocessableError extends AppError {
  constructor(code, message) {
    super(422, 'invalid_request_error', code, message);
  }
}

class RateLimitError extends AppError {
  constructor(code, message, retryAfterSec) {
    super(429, 'rate_limit_error', code, message);
    this.retryAfterSec = retryAfterSec;
  }
}

function formatError(err, requestId) {
  return {
    error: {
      type: err.type,
      code: err.code,
      message: err.message,
      request_id: requestId,
    },
  };
}

module.exports = {
  AppError,
  BadRequestError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableError,
  RateLimitError,
  formatError,
};

