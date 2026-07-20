export const RESULT_SCHEMA_VERSION = 1 as const;

export type Oid = string;

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "SESSION_EXPIRED"
  | "GIT_INTEGRATION_UNAVAILABLE"
  | "REPO_NOT_FOUND"
  | "BINDING_INVALID"
  | "DIRTY_WORKTREE"
  | "PLAN_STALE"
  | "REMOTE_MOVED"
  | "REMOTE_REWRITTEN"
  | "CONFLICT"
  | "OPERATION_IN_PROGRESS"
  | "LOCKED"
  | "NETWORK"
  | "RATE_LIMITED"
  | "GIT_FAILED"
  | "INTERNAL";

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface OperationResult<T> {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  operationId: string;
  status: "ok" | "noop";
  warnings: string[];
  data: T;
}

export interface ProjectBinding {
  schemaVersion: 1;
  profile: string;
  projectId: string;
  projectName?: string;
  webUrl: string;
  gitUrl: string;
  remoteName: string;
  localBranch: string;
  remoteBranch: string;
  sync: {
    mergeStrategy: "merge";
    include: string[];
    exclude: string[];
    quietPeriodMs: number;
  };
}

export type GitOperation =
  | "none"
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "bisect";

export interface WorktreeStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  outOfScope?: string[];
}

export interface RepositorySnapshot {
  repositoryPath: string;
  gitDir: string;
  branch: string | null;
  headOid: Oid | null;
  remoteName: string | null;
  remoteBranch: string | null;
  remoteOid: Oid | null;
  operation: GitOperation;
  worktree: WorktreeStatus;
  worktreeFingerprint: string;
}

export type CommitRelationship =
  | "equal"
  | "local_ahead"
  | "remote_ahead"
  | "diverged"
  | "local_unborn"
  | "remote_unborn"
  | "both_unborn";

export interface SyncObservation {
  snapshot: RepositorySnapshot;
  relationship: CommitRelationship;
  remoteRewritten: boolean;
  lastRemoteOid?: Oid;
}

export type SyncClassification =
  | "equal_clean"
  | "equal_dirty"
  | "local_ahead"
  | "remote_ahead"
  | "diverged"
  | "remote_rewritten"
  | "operation_in_progress"
  | "unborn"
  | "invalid";

export type DirtyPolicy = "fail" | "checkpoint" | "stash";
export type RewritePolicy = "fail" | "remote" | "local";

export interface PlanOptions {
  dirtyPolicy: DirtyPolicy;
  rewritePolicy: RewritePolicy;
  commitMessage?: string;
  direction?: "sync" | "pull" | "push";
}

export interface ApplyOptions extends PlanOptions {
  confirmation?: boolean;
}

export type SyncAction =
  | { type: "checkpoint"; paths: string[]; message?: string }
  | { type: "create_backup_ref"; target: "local" | "remote" | "both" }
  | { type: "fast_forward"; oid: Oid }
  | { type: "merge"; oid: Oid }
  | { type: "push"; expectedRemoteOid: Oid | null }
  | { type: "reset_to_remote"; oid: Oid }
  | { type: "force_push_with_lease"; expectedRemoteOid: Oid };

export interface SyncPlan {
  schemaVersion: 1;
  planId: string;
  classification: SyncClassification;
  preconditions: {
    repositoryPath: string;
    branch: string | null;
    headOid: Oid | null;
    remoteOid: Oid | null;
    worktreeFingerprint: string;
  };
  actions: SyncAction[];
  risks: string[];
  warnings: string[];
  requiresConfirmation: boolean;
  blockedBy?: ErrorDetails;
}

export interface StatusReport {
  bound: boolean;
  binding?: ProjectBinding;
  snapshot: RepositorySnapshot;
  activeOperation?: SyncState["activeOperation"];
}

export interface InspectOptions {
  fetch: boolean;
  lastRemoteOid?: Oid;
}

export interface ApplyReport {
  planId: string;
  classification: SyncClassification;
  appliedActions: SyncAction["type"][];
  headOid: Oid | null;
  remoteOid: Oid | null;
}

export interface BindingPlan {
  schemaVersion: 1;
  planId: string;
  binding: ProjectBinding;
  preconditions: {
    repositoryPath: string;
    branch: string | null;
    headOid: Oid | null;
    worktreeFingerprint: string;
  };
  actions: Array<"add_or_validate_remote" | "write_binding">;
  alreadyBound: boolean;
}

export interface BindingApplyReport {
  planId: string;
  projectId: string;
  remoteName: string;
  remoteBranch: string;
  alreadyBound: boolean;
}

export interface UnbindPlan {
  schemaVersion: 1;
  planId: string;
  projectId: string;
  remoteName: string;
  actions: Array<"remove_remote" | "delete_config">;
}

export interface UnbindApplyReport {
  planId: string;
  projectId: string;
  remoteName: string;
  remoteRemoved: boolean;
  configDeleted: boolean;
}

export interface ConflictFile {
  path: string;
  stages: Array<1 | 2 | 3>;
}

export interface ConflictReport {
  operationId: string;
  gitOperation: GitOperation;
  files: ConflictFile[];
}

export interface ConflictResolutionReport {
  operationId: string;
  path: string;
  resolution: "ours" | "theirs";
  remaining: ConflictFile[];
}

export interface ConflictContinueReport {
  operationId: string;
  headOid: Oid;
  remoteOid: Oid;
}

export interface ConflictAbortReport {
  operationId: string;
  headOid: Oid | null;
}

export interface RepositoryPort {
  inspect(
    repositoryPath: string,
    binding: ProjectBinding | undefined,
    options: InspectOptions,
  ): Promise<SyncObservation>;
  bind(repositoryPath: string, binding: ProjectBinding): Promise<string>;
  apply(
    repositoryPath: string,
    binding: ProjectBinding,
    plan: SyncPlan,
    operationId: string,
  ): Promise<void>;
  listConflicts(repositoryPath: string): Promise<ConflictFile[]>;
  resolveConflict(
    repositoryPath: string,
    path: string,
    resolution: "ours" | "theirs",
  ): Promise<void>;
  continueConflict(
    repositoryPath: string,
    binding: ProjectBinding,
    mergeTargetOid: Oid,
    expectedRemoteOid: Oid,
  ): Promise<void>;
  abortConflict(repositoryPath: string, operationId: string): Promise<void>;
  unbind(repositoryPath: string, remoteName: string): Promise<void>;
}

export interface BindingStorePort {
  read(repositoryPath: string): Promise<ProjectBinding | undefined>;
  write(repositoryPath: string, binding: ProjectBinding): Promise<void>;
  delete(repositoryPath: string): Promise<void>;
}

export interface OperationIdPort {
  next(): string;
}

export type SecretKind = "git-token" | "web-cookie";

export interface SecretStorePort {
  get(profile: string, kind: SecretKind): Promise<string | undefined>;
  set(profile: string, kind: SecretKind, value: string): Promise<void>;
  delete(profile: string, kind: SecretKind): Promise<void>;
}

export interface GitCredentialProviderPort {
  getGitToken(profile: string): Promise<string | undefined>;
}

export interface SyncState {
  schemaVersion: 1;
  lastSuccessfulSync?: {
    localOid: Oid;
    remoteOid: Oid;
    at: string;
  };
  activeOperation?: {
    operationId: string;
    planId: string;
    phase: "applying" | "conflict" | "failed";
    startedAt: string;
    errorCode?: ErrorCode;
    mergeTargetOid?: Oid;
    expectedRemoteOid?: Oid;
  };
}

export interface StateStorePort {
  read(repositoryPath: string): Promise<SyncState>;
  write(repositoryPath: string, state: SyncState): Promise<void>;
}

export interface RepositoryLockHandle {
  release(): Promise<void>;
}

export interface RepositoryLockPort {
  acquire(
    repositoryPath: string,
    operationId: string,
  ): Promise<RepositoryLockHandle>;
}
