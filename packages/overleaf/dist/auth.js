import { OverleafyError, } from "@nyanifold/core";
const REQUEST_TIMEOUT_MS = 30_000;
function normalizeWebUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch (error) {
        throw new OverleafyError("BINDING_INVALID", "Invalid Overleaf web URL.", {
            cause: error,
        });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new OverleafyError("BINDING_INVALID", "Overleaf web URL must use HTTP or HTTPS.");
    }
    if (url.username !== "" || url.password !== "") {
        throw new OverleafyError("BINDING_INVALID", "Overleaf web URL must not contain credentials.");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
export function normalizeCookie(raw) {
    const value = raw.trim();
    if (value === "" || /[\r\n]/.test(value)) {
        throw new OverleafyError("AUTH_REQUIRED", "The Overleaf Cookie is empty or invalid.");
    }
    return value.includes("=") ? value : `overleaf_session2=${value}`;
}
function parseCookiePairs(raw) {
    const pairs = new Map();
    for (const part of raw.split(/;\s*/)) {
        const separator = part.indexOf("=");
        if (separator > 0) {
            pairs.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
        }
    }
    return pairs;
}
export function mergeCookies(existing, setCookieHeaders) {
    const pairs = parseCookiePairs(existing);
    for (const header of setCookieHeaders) {
        const firstSegment = header.split(";", 1)[0] ?? "";
        const separator = firstSegment.indexOf("=");
        if (separator > 0) {
            pairs.set(firstSegment.slice(0, separator).trim(), firstSegment.slice(separator + 1).trim());
        }
    }
    return [...pairs].map(([key, value]) => `${key}=${value}`).join("; ");
}
function csrfToken(html) {
    return (/<meta\s+name=["']ol-csrfToken["']\s+content=["']([^"']+)["']/i.exec(html)?.[1] ??
        /<input\b[^>]*name=["']_csrf["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1] ??
        /["']csrfToken["']\s*:\s*["']([^"']+)["']/i.exec(html)?.[1]);
}
function isAuthenticationResponse(response) {
    if (response.status === 401 || response.status === 403) {
        return true;
    }
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")?.toLowerCase() ?? "";
        return (location.includes("/login") ||
            location.includes("/oauth") ||
            location.includes("/saml"));
    }
    return false;
}
function project(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const record = value;
    const id = typeof record._id === "string"
        ? record._id
        : typeof record.id === "string"
            ? record.id
            : undefined;
    if (id === undefined || typeof record.name !== "string") {
        return undefined;
    }
    const owner = typeof record.owner === "object" && record.owner !== null
        ? record.owner
        : undefined;
    return {
        id,
        name: record.name,
        ...(typeof record.lastUpdated === "string"
            ? { lastUpdated: record.lastUpdated }
            : {}),
        ...(owner === undefined
            ? {}
            : {
                owner: {
                    ...(typeof owner.firstName === "string"
                        ? { firstName: owner.firstName }
                        : {}),
                    ...(typeof owner.lastName === "string"
                        ? { lastName: owner.lastName }
                        : {}),
                },
            }),
    };
}
export class OverleafAuthService {
    secrets;
    fetcher;
    constructor(secrets, fetcher = fetch) {
        this.secrets = secrets;
        this.fetcher = fetcher;
    }
    async setGitToken(profile, token) {
        await this.secrets.set(profile, "git-token", token.trim());
    }
    async status(profile) {
        const [gitToken, webCookie] = await Promise.all([
            this.secrets.get(profile, "git-token"),
            this.secrets.get(profile, "web-cookie"),
        ]);
        return {
            profile,
            hasGitToken: gitToken !== undefined && gitToken !== "",
            hasWebCookie: webCookie !== undefined && webCookie !== "",
        };
    }
    async importCookie(profile, rawWebUrl, rawCookie) {
        const webUrl = normalizeWebUrl(rawWebUrl);
        const cookie = normalizeCookie(rawCookie);
        const response = await this.request(`${webUrl}/project`, cookie);
        if (isAuthenticationResponse(response)) {
            throw this.sessionExpired();
        }
        if (!response.ok) {
            throw this.httpFailure(response);
        }
        const html = await response.text();
        const token = csrfToken(html);
        if (token === undefined) {
            throw this.sessionExpired();
        }
        const updatedCookie = mergeCookies(cookie, response.headers.getSetCookie());
        await this.secrets.set(profile, "web-cookie", updatedCookie);
        return { profile, webUrl, csrfToken: token };
    }
    async listProjects(profile, rawWebUrl) {
        const webUrl = normalizeWebUrl(rawWebUrl);
        const cookie = await this.secrets.get(profile, "web-cookie");
        if (cookie === undefined || cookie === "") {
            throw new OverleafyError("AUTH_REQUIRED", `No browser session Cookie is stored for profile '${profile}'.`, {
                remediation: "Complete SSO in a browser, then run auth import-cookie for this profile.",
            });
        }
        const response = await this.request(`${webUrl}/user/projects`, cookie);
        if (isAuthenticationResponse(response)) {
            throw this.sessionExpired();
        }
        if (!response.ok) {
            throw this.httpFailure(response);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
            throw this.sessionExpired();
        }
        let data;
        try {
            data = (await response.json());
        }
        catch (error) {
            throw new OverleafyError("GIT_INTEGRATION_UNAVAILABLE", "Overleaf returned an invalid project-list response.", { cause: error });
        }
        const values = Array.isArray(data.projects) ? data.projects : [];
        const projects = values
            .map((value) => project(value))
            .filter((value) => value !== undefined);
        const updatedCookie = mergeCookies(cookie, response.headers.getSetCookie());
        if (updatedCookie !== cookie) {
            await this.secrets.set(profile, "web-cookie", updatedCookie);
        }
        return projects;
    }
    async downloadZip(profile, webUrl, projectId) {
        const cookie = await this.secrets.get(profile, "web-cookie");
        if (cookie === undefined || cookie === "") {
            throw new OverleafyError("AUTH_REQUIRED", `No browser session Cookie is stored for profile '${profile}'.`, {
                remediation: "Complete SSO in a browser, then run auth import-cookie for this profile.",
            });
        }
        const url = `${normalizeWebUrl(webUrl)}/project/${projectId}/download/zip`;
        const response = await this.fetcher(url, {
            method: "GET",
            redirect: "manual",
            headers: { cookie },
            signal: AbortSignal.timeout(120_000),
        });
        if (isAuthenticationResponse(response)) {
            throw this.sessionExpired();
        }
        if (!response.ok) {
            throw this.httpFailure(response);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
    async request(url, cookie) {
        try {
            return await this.fetcher(url, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "application/json, text/html;q=0.9",
                    cookie,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        }
        catch (error) {
            throw new OverleafyError("NETWORK", "Unable to reach the Overleaf web service.", { retryable: true, cause: error });
        }
    }
    sessionExpired() {
        return new OverleafyError("SESSION_EXPIRED", "The Overleaf browser session is invalid or expired.", {
            remediation: "Complete SSO in a browser again and import the refreshed Cookie.",
        });
    }
    httpFailure(response) {
        if (response.status === 429) {
            return new OverleafyError("RATE_LIMITED", "Overleaf rate-limited the request.", { retryable: true, details: { status: response.status } });
        }
        return new OverleafyError("GIT_INTEGRATION_UNAVAILABLE", `Overleaf web API returned HTTP ${response.status}.`, { details: { status: response.status } });
    }
}
//# sourceMappingURL=auth.js.map