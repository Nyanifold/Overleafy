import { toErrorDetails, } from "@nyanifold/core";
export function writeResult(result, json, human) {
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${human(result.data)}\n`);
}
export function writeError(error, json) {
    const details = toErrorDetails(error);
    if (json) {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            status: "error",
            error: details,
        })}\n`);
    }
    else {
        process.stderr.write(`Error [${details.code}]: ${details.message}\n`);
        if (details.remediation !== undefined) {
            process.stderr.write(`${details.remediation}\n`);
        }
    }
}
export function formatStatus(status) {
    const { snapshot } = status;
    const changes = snapshot.worktree.staged.length +
        snapshot.worktree.unstaged.length +
        snapshot.worktree.untracked.length +
        (snapshot.worktree.outOfScope?.length ?? 0);
    return [
        `Repository: ${snapshot.repositoryPath}`,
        `Binding: ${status.bound ? `${status.binding?.projectId} (${status.binding?.remoteName})` : "not configured"}`,
        `Branch: ${snapshot.branch ?? "detached"}`,
        `HEAD: ${snapshot.headOid ?? "unborn"}`,
        `Remote: ${snapshot.remoteOid ?? "not fetched"}`,
        `Worktree: ${changes === 0 ? "clean" : `${changes} changed path(s)`}`,
        `Operation: ${snapshot.operation}`,
        `Sync operation: ${status.activeOperation?.operationId ?? "none"}`,
    ].join("\n");
}
export function formatPlan(plan) {
    const lines = [
        `Plan: ${plan.planId}`,
        `Classification: ${plan.classification}`,
        `Actions: ${plan.actions.length}`,
    ];
    for (const action of plan.actions) {
        lines.push(`  - ${action.type}`);
    }
    if (plan.blockedBy !== undefined) {
        lines.push(`Blocked: [${plan.blockedBy.code}] ${plan.blockedBy.message}`);
        if (plan.blockedBy.remediation !== undefined) {
            lines.push(`  ${plan.blockedBy.remediation}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=output.js.map