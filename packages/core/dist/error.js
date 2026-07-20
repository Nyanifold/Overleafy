export class OverleafyError extends Error {
    details;
    constructor(code, message, options = {}) {
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
export function toErrorDetails(error) {
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
//# sourceMappingURL=error.js.map