// ── Custom error classes with consistent API error shape ──

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly type: string;
  public readonly code: string;

  constructor(statusCode: number, type: string, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 400
export class BadRequestError extends AppError {
  constructor(code: string, message: string) {
    super(400, 'invalid_request_error', code, message);
  }
}

// 401
export class AuthenticationError extends AppError {
  constructor(message = 'Invalid or missing API key') {
    super(401, 'authentication_error', 'invalid_api_key', message);
  }
}

// 403
export class ForbiddenError extends AppError {
  constructor(code: string, message: string) {
    super(403, 'forbidden_error', code, message);
  }
}

// 404
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'not_found_error', 'resource_not_found', `${resource} not found`);
  }
}

// 409
export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, 'conflict_error', code, message);
  }
}

// 422
export class UnprocessableError extends AppError {
  constructor(code: string, message: string) {
    super(422, 'invalid_request_error', code, message);
  }
}

// 429
export class RateLimitError extends AppError {
  public readonly retryAfterSec?: number;

  constructor(code: string, message: string, retryAfterSec?: number) {
    super(429, 'rate_limit_error', code, message);
    this.retryAfterSec = retryAfterSec;
  }
}

// 500
export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(500, 'internal_error', 'internal_error', message);
  }
}

export function formatError(err: AppError, requestId: string) {
  return {
    error: {
      type: err.type,
      code: err.code,
      message: err.message,
      request_id: requestId,
    },
  };
}

