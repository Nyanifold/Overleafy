import { type GitCredentialProviderPort, type SecretKind, type SecretStorePort } from "@nyanifold/core";
export declare class KeyringSecretStore implements SecretStorePort {
    get(profile: string, kind: SecretKind): Promise<string | undefined>;
    set(profile: string, kind: SecretKind, value: string): Promise<void>;
    delete(profile: string, kind: SecretKind): Promise<void>;
    private unavailable;
}
export declare class FileSecretStore implements SecretStorePort {
    get(profile: string, kind: SecretKind): Promise<string | undefined>;
    set(profile: string, kind: SecretKind, value: string): Promise<void>;
    delete(profile: string, kind: SecretKind): Promise<void>;
}
export declare class ProfileGitCredentials implements GitCredentialProviderPort {
    private readonly secrets;
    constructor(secrets: SecretStorePort);
    getGitToken(profile: string): Promise<string | undefined>;
}
export declare class MemorySecretStore implements SecretStorePort {
    private readonly values;
    get(profile: string, kind: SecretKind): Promise<string | undefined>;
    set(profile: string, kind: SecretKind, value: string): Promise<void>;
    delete(profile: string, kind: SecretKind): Promise<void>;
}
//# sourceMappingURL=secret-store.d.ts.map