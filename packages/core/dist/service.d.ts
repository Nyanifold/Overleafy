import { type ApplyOptions, type ApplyReport, type BindingApplyReport, type BindingPlan, type BindingStorePort, type UnbindApplyReport, type UnbindPlan, type ConflictAbortReport, type ConflictContinueReport, type ConflictReport, type ConflictResolutionReport, type OperationIdPort, type OperationResult, type PlanOptions, type ProjectBinding, type RepositoryPort, type RepositoryLockPort, type StateStorePort, type StatusReport, type SyncPlan } from "./types.js";
export declare class SyncService {
    private readonly repositories;
    private readonly bindings;
    private readonly execution?;
    private readonly operationIds;
    constructor(repositories: RepositoryPort, bindings: BindingStorePort, execution?: {
        states: StateStorePort;
        locks: RepositoryLockPort;
    } | undefined, operationIds?: OperationIdPort);
    status(repositoryPath: string): Promise<OperationResult<StatusReport>>;
    plan(repositoryPath: string, options: PlanOptions): Promise<OperationResult<SyncPlan>>;
    apply(repositoryPath: string, planId: string, options: ApplyOptions): Promise<OperationResult<ApplyReport>>;
    bind(repositoryPath: string, binding: ProjectBinding): Promise<OperationResult<ProjectBinding>>;
    planBinding(repositoryPath: string, binding: ProjectBinding): Promise<OperationResult<BindingPlan>>;
    applyBinding(repositoryPath: string, binding: ProjectBinding, planId: string): Promise<OperationResult<BindingApplyReport>>;
    planUnbind(repositoryPath: string): Promise<OperationResult<UnbindPlan>>;
    applyUnbind(repositoryPath: string, planId: string): Promise<OperationResult<UnbindApplyReport>>;
    conflicts(repositoryPath: string): Promise<OperationResult<ConflictReport>>;
    resolveConflict(repositoryPath: string, filePath: string, resolution: "ours" | "theirs", expectedOperationId?: string): Promise<OperationResult<ConflictResolutionReport>>;
    continueConflict(repositoryPath: string, expectedOperationId?: string): Promise<OperationResult<ConflictContinueReport>>;
    abortConflict(repositoryPath: string, expectedOperationId?: string): Promise<OperationResult<ConflictAbortReport>>;
    private requireBinding;
    private requireExecution;
    private requireConflictOperation;
    private validatePlan;
    private validateLocalBranch;
    private validateOperationId;
    private result;
}
//# sourceMappingURL=service.d.ts.map