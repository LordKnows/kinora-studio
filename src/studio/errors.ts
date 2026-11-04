/* The error model of §7.4. Every non-2xx answer is { error: { code, message, details } }. */

export type ErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "not_approved"
  | "needs_confirm"
  | "budget_exceeded"
  | "backend_error";

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_approved: 409,
  needs_confirm: 409,
  budget_exceeded: 409,
  backend_error: 502,
};

export class StudioError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "StudioError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export function notFound(what: string, id?: string): StudioError {
  return new StudioError("not_found", id ? `${what} ${id} not found` : `${what} not found`);
}
