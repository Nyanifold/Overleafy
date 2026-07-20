import type { GitCredentialProviderPort, ProjectBinding } from "@nyanifold/core";
export declare function withGitAskpass<T>(binding: ProjectBinding, credentials: GitCredentialProviderPort | undefined, action: (env: NodeJS.ProcessEnv | undefined) => Promise<T>): Promise<T>;
//# sourceMappingURL=askpass.d.ts.map