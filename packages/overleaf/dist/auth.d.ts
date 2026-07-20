import { type SecretStorePort } from "@nyanifold/core";
export interface AuthProfileStatus {
    profile: string;
    hasGitToken: boolean;
    hasWebCookie: boolean;
}
export interface WebSession {
    profile: string;
    webUrl: string;
    csrfToken: string;
}
export interface OverleafProject {
    id: string;
    name: string;
    lastUpdated?: string;
    owner?: {
        firstName?: string;
        lastName?: string;
    };
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare function normalizeCookie(raw: string): string;
export declare function mergeCookies(existing: string, setCookieHeaders: readonly string[]): string;
export declare class OverleafAuthService {
    private readonly secrets;
    private readonly fetcher;
    constructor(secrets: SecretStorePort, fetcher?: FetchLike);
    setGitToken(profile: string, token: string): Promise<void>;
    status(profile: string): Promise<AuthProfileStatus>;
    importCookie(profile: string, rawWebUrl: string, rawCookie: string): Promise<WebSession>;
    listProjects(profile: string, rawWebUrl: string): Promise<OverleafProject[]>;
    downloadZip(profile: string, webUrl: string, projectId: string): Promise<Buffer>;
    private request;
    private sessionExpired;
    private httpFailure;
}
//# sourceMappingURL=auth.d.ts.map