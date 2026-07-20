import { type StateStorePort, type SyncState } from "@nyanifold/core";
export declare class FileStateStore implements StateStorePort {
    read(repositoryPath: string): Promise<SyncState>;
    write(repositoryPath: string, state: SyncState): Promise<void>;
}
//# sourceMappingURL=state-store.d.ts.map