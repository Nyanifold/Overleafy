import type { ErrorCode, ErrorDetails } from "./types.js";
export declare class OverleafyError extends Error {
    readonly details: ErrorDetails;
    constructor(code: ErrorCode, message: string, options?: {
        retryable?: boolean;
        remediation?: string;
        details?: Record<string, unknown>;
        cause?: unknown;
    });
}
export declare function toErrorDetails(error: unknown): ErrorDetails;
//# sourceMappingURL=error.d.ts.map