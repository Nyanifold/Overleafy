import type { ErrorCode, ErrorDetails } from "./types.js";

export class OverleafyError extends Error {
  readonly details: ErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      remediation?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OverleafyError";
    this.details = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.remediation === undefined
        ? {}
        : { remediation: options.remediation }),
      ...(options.details === undefined ? {} : { details: options.details }),
    };
  }
}

export function toErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof OverleafyError) {
    return error.details;
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL",
    message,
    retryable: false,
  };
}
