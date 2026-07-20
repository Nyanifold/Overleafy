import { type OperationResult, type StatusReport, type SyncPlan } from "@nyanifold/core";
export declare function writeResult<T>(result: OperationResult<T>, json: boolean, human: (data: T) => string): void;
export declare function writeError(error: unknown, json: boolean): void;
export declare function formatStatus(status: StatusReport): string;
export declare function formatPlan(plan: SyncPlan): string;
//# sourceMappingURL=output.d.ts.map