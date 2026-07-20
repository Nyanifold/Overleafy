import { type RepositoryLockHandle, type RepositoryLockPort } from "@nyanifold/core";
export declare class FileRepositoryLock implements RepositoryLockPort {
    acquire(repositoryPath: string, operationId: string): Promise<RepositoryLockHandle>;
}
//# sourceMappingURL=repository-lock.d.ts.map