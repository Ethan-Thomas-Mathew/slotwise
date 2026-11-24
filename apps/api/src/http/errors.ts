/**
 * One error type for "expected" failures (bad input, not found, conflict...).
 * The global error handler turns it into the standard JSON shape:
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */
type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_TAKEN'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'BAD_SIGNATURE'
  | 'PAYMENT_PROVIDER_ERROR'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SLOT_TAKEN: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  CSRF_FAILED: 403,
  BAD_SIGNATURE: 400,
  PAYMENT_PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
