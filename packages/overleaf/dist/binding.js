import { OverleafyError, } from "@nyanifold/core";
function normalizeBaseUrl(raw, label) {
    let url;
    try {
        url = new URL(raw);
    }
    catch (error) {
        throw new OverleafyError("BINDING_INVALID", `Invalid ${label}: ${raw}`, { cause: error });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new OverleafyError("BINDING_INVALID", `${label} must use HTTP or HTTPS.`);
    }
    if (url.username !== "" || url.password !== "") {
        throw new OverleafyError("BINDING_INVALID", `${label} must not include credentials.`);
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
export function extractProjectId(project) {
    const trimmed = project.trim();
    if (/^[a-fA-F0-9]{6,64}$/.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    try {
        const url = new URL(trimmed);
        const parts = url.pathname.split("/").filter(Boolean);
        const projectIndex = parts.indexOf("project");
        const candidate = projectIndex >= 0 ? parts[projectIndex + 1] : parts.at(-1);
        if (candidate !== undefined && /^[a-fA-F0-9]{6,64}$/.test(candidate)) {
            return candidate.toLowerCase();
        }
    }
    catch {
        // Convert to a structured binding error below.
    }
    throw new OverleafyError("BINDING_INVALID", "Project must be a hexadecimal project ID or an Overleaf project URL.", {
        remediation: "Use an ID from the Overleaf project URL, for example 0123456789abcdef01234567.",
    });
}
export function createProjectBinding(options) {
    const projectId = extractProjectId(options.project);
    const webUrl = normalizeBaseUrl(options.webUrl ?? "https://www.overleaf.com", "web URL");
    const gitUrl = normalizeBaseUrl(options.gitUrl ?? `https://git.overleaf.com/${projectId}`, "Git URL");
    return {
        schemaVersion: 1,
        profile: options.profile ?? "default",
        projectId,
        ...(options.projectName === undefined
            ? {}
            : { projectName: options.projectName }),
        webUrl,
        gitUrl,
        remoteName: options.remoteName ?? "overleaf",
        localBranch: options.localBranch,
        remoteBranch: options.remoteBranch ?? "master",
        sync: {
            mergeStrategy: "merge",
            include: ["**"],
            exclude: [".git/**", ".overleafy/**", ".output/**"],
            quietPeriodMs: 2_000,
        },
    };
}
//# sourceMappingURL=binding.js.map