/**
 * One error shape for the whole API:
 *
 *   HTTP <status>
 *   { "error": { "code": "quota_exceeded", "message": "...", "docs": "https://.../docs/api#errors" } }
 *
 * Throw ApiError anywhere below a route; src/index.ts turns it into the JSON
 * above. Codes are part of the public contract (documented in /docs/api and
 * openapi.yaml) - add new ones here, never inline.
 */

export const ERROR_STATUS = {
  invalid_request: 400,
  unsupported_size: 400,
  unsupported_format: 400,
  unauthorized: 401,
  invalid_api_key: 401,
  quota_exceeded: 402,
  invalid_signature: 403,
  account_suspended: 403,
  plan_required: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  template_error: 422,
  image_fetch_failed: 422,
  rate_limited: 429,
  render_failed: 500,
  internal_error: 500,
  not_configured: 503,
  render_timeout: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; docs: string; details?: Record<string, unknown> };
}

export function errorBody(err: ApiError, appUrl: string): ErrorBody {
  const base = appUrl.replace(/\/+$/, '');
  return {
    error: {
      code: err.code,
      message: err.message,
      docs: `${base}/docs/api#errors`,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

/** Errors are never cached, so a fixed card URL recovers as soon as the cause is fixed. */
export function errorResponse(err: ApiError, appUrl: string): Response {
  return new Response(JSON.stringify(errorBody(err, appUrl)), {
    status: err.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(err.headers ?? {}),
    },
  });
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
