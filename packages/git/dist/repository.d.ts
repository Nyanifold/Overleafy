import { type ConflictFile, type GitCredentialProviderPort, type ProjectBinding, type RepositoryPort, type SyncPlan, type SyncObservation } from "@nyanifold/core";
import { GitRunner } from "./runner.js";
export declare class GitRepository implements RepositoryPort {
    private readonly runner;
    private readonly credentials?;
    constructor(runner?: GitRunner, credentials?: GitCredentialProviderPort | undefined);
    inspect(repositoryPath: string, binding: ProjectBinding | undefined, options: {
        fetch: boolean;
        lastRemoteOid?: string;
    }): Promise<SyncObservation>;
    bind(repositoryPath: string, binding: ProjectBinding): Promise<string>;
    unbind(repositoryPath: string, remoteName: string): Promise<void>;
    apply(repositoryPath: string, binding: ProjectBinding, plan: SyncPlan, operationId: string): Promise<void>;
    listConflicts(repositoryPath: string): Promise<ConflictFile[]>;
    resolveConflict(repositoryPath: string, filePath: string, resolution: "ours" | "theirs"): Promise<void>;
    continueConflict(repositoryPath: string, binding: ProjectBinding, mergeTargetOid: string, expectedRemoteOid: string): Promise<void>;
    abortConflict(repositoryPath: string, operationId: string): Promise<void>;
    private resolveRoot;
    private fetch;
    private optionalRevParse;
    private snapshot;
    private operation;
    private filterWorktree;
    private fingerprintWorktree;
    private hashFile;
    private relationship;
    private isAncestor;
    private createBackupRefs;
    private verifyRemoteLease;
    private readRemoteOid;
    private remoteMoved;
    private withAuthentication;
    private ensureLocalExclude;
    private assertBoundRemote;
    private assertCredentialFreeUrl;
    private redactUrl;
}
//# sourceMappingURL=repository.d.ts.map