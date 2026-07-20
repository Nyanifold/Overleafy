import { sha256 } from "./canonical.js";
function isDirty(observation) {
    const { worktree } = observation.snapshot;
    return (worktree.staged.length > 0 ||
        worktree.unstaged.length > 0 ||
        worktree.untracked.length > 0 ||
        (worktree.outOfScope?.length ?? 0) > 0);
}
function dirtyPaths(observation) {
    const { worktree } = observation.snapshot;
    return [
        ...new Set([
            ...worktree.staged,
            ...worktree.unstaged,
            ...worktree.untracked,
        ]),
    ].sort();
}
function classify(observation) {
    const { snapshot, relationship, remoteRewritten } = observation;
    if (snapshot.operation !== "none" || snapshot.worktree.conflicted.length > 0) {
        return "operation_in_progress";
    }
    if (snapshot.branch === null) {
        return "invalid";
    }
    if (remoteRewritten) {
        return "remote_rewritten";
    }
    if (relationship === "both_unborn" ||
        relationship === "local_unborn" ||
        relationship === "remote_unborn") {
        return "unborn";
    }
    if (relationship === "equal") {
        return isDirty(observation) ? "equal_dirty" : "equal_clean";
    }
    return relationship;
}
function blocked(code, message, remediation) {
    return {
        code,
        message,
        retryable: false,
        remediation,
    };
}
export function planSync(observation, options) {
    const classification = classify(observation);
    const { snapshot } = observation;
    const actions = [];
    const risks = [];
    const warnings = [];
    let requiresConfirmation = false;
    let blockedBy;
    const checkpointIfNeeded = () => {
        if (!isDirty(observation)) {
            return true;
        }
        if ((observation.snapshot.worktree.outOfScope?.length ?? 0) > 0) {
            blockedBy = blocked("DIRTY_WORKTREE", "Tracked or staged changes exist outside the configured sync scope.", "Commit, restore, or update include/exclude configuration before syncing.");
            return false;
        }
        if (options.dirtyPolicy === "fail") {
            blockedBy = blocked("DIRTY_WORKTREE", "The worktree contains local changes.", "Re-run with dirtyPolicy=checkpoint and provide a commit message, or commit the changes manually.");
            return false;
        }
        if (options.dirtyPolicy === "stash") {
            blockedBy = blocked("DIRTY_WORKTREE", "Stash planning is not valid for a complete two-way sync.", "Use dirtyPolicy=checkpoint or make the worktree clean.");
            return false;
        }
        const message = options.commitMessage?.trim() || "overleafy checkpoint";
        actions.push({
            type: "checkpoint",
            paths: dirtyPaths(observation),
            message,
        });
        return true;
    };
    switch (classification) {
        case "equal_clean":
            break;
        case "equal_dirty":
            if (checkpointIfNeeded()) {
                actions.push({
                    type: "push",
                    expectedRemoteOid: snapshot.remoteOid,
                });
            }
            break;
        case "local_ahead":
            if (checkpointIfNeeded()) {
                actions.push({
                    type: "push",
                    expectedRemoteOid: snapshot.remoteOid,
                });
            }
            break;
        case "remote_ahead":
            if (checkpointIfNeeded() && snapshot.remoteOid !== null) {
                if (isDirty(observation)) {
                    actions.push({ type: "create_backup_ref", target: "both" });
                    actions.push({ type: "merge", oid: snapshot.remoteOid });
                    actions.push({
                        type: "push",
                        expectedRemoteOid: snapshot.remoteOid,
                    });
                }
                else {
                    actions.push({ type: "fast_forward", oid: snapshot.remoteOid });
                }
            }
            break;
        case "diverged":
            if (checkpointIfNeeded() && snapshot.remoteOid !== null) {
                actions.push({ type: "create_backup_ref", target: "both" });
                actions.push({ type: "merge", oid: snapshot.remoteOid });
                actions.push({
                    type: "push",
                    expectedRemoteOid: snapshot.remoteOid,
                });
            }
            break;
        case "remote_rewritten":
            risks.push("The remote branch history was rewritten.");
            requiresConfirmation = true;
            if (options.rewritePolicy === "fail") {
                blockedBy = blocked("REMOTE_REWRITTEN", "The remote branch no longer descends from the last observed remote commit.", "Inspect the history, then choose rewritePolicy=remote or rewritePolicy=local explicitly.");
            }
            else if (snapshot.remoteOid === null) {
                blockedBy = blocked("REMOTE_REWRITTEN", "The rewritten remote branch has no commit.", "Inspect the remote branch before choosing a recovery policy.");
            }
            else if (checkpointIfNeeded()) {
                if (options.rewritePolicy === "remote") {
                    actions.push({ type: "create_backup_ref", target: "local" });
                    actions.push({ type: "reset_to_remote", oid: snapshot.remoteOid });
                }
                else {
                    actions.push({ type: "create_backup_ref", target: "remote" });
                    actions.push({
                        type: "force_push_with_lease",
                        expectedRemoteOid: snapshot.remoteOid,
                    });
                }
            }
            break;
        case "operation_in_progress":
            blockedBy = blocked(snapshot.worktree.conflicted.length > 0
                ? "CONFLICT"
                : "OPERATION_IN_PROGRESS", "The repository already has an operation in progress.", "Continue or abort the existing operation before planning another sync.");
            break;
        case "unborn":
            if (observation.relationship === "local_unborn" && snapshot.remoteOid !== null) {
                // Remote has commits, local is empty — fast-forward to bring content in.
                actions.push({ type: "fast_forward", oid: snapshot.remoteOid });
            }
            else if (checkpointIfNeeded() &&
                (snapshot.headOid !== null || isDirty(observation))) {
                // both_unborn or remote_unborn: create local commit and push to initialize remote.
                actions.push({ type: "push", expectedRemoteOid: snapshot.remoteOid });
            }
            else if (snapshot.headOid === null && !isDirty(observation)) {
                blockedBy = blocked("DIRTY_WORKTREE", "No local commits and no files to commit.", "Add files and commit them, or set dirtyPolicy=checkpoint with at least one tracked file.");
            }
            break;
        case "invalid":
            blockedBy = blocked("BINDING_INVALID", "The repository is not on a named local branch.", "Switch to the configured local branch before syncing.");
            break;
    }
    // Filter actions for one-directional pull/push mode.
    const direction = options.direction ?? "sync";
    if (direction === "pull") {
        const pullActions = actions.filter((a) => a.type !== "push" && a.type !== "force_push_with_lease");
        actions.length = 0;
        actions.push(...pullActions);
        if (actions.length === 0 && classification !== "equal_clean" && !blockedBy) {
            blockedBy = blocked("BINDING_INVALID", "No local changes to pull.", "The remote has no new commits to bring in.");
        }
    }
    else if (direction === "push") {
        const pushActions = actions.filter((a) => a.type === "push" ||
            a.type === "force_push_with_lease" ||
            a.type === "checkpoint" ||
            a.type === "create_backup_ref");
        actions.length = 0;
        actions.push(...pushActions);
        if (actions.length === 0 && classification !== "equal_clean" && !blockedBy) {
            blockedBy = blocked("BINDING_INVALID", "No local commits to push.", "Commit local changes before pushing.");
        }
    }
    const preconditions = {
        repositoryPath: snapshot.repositoryPath,
        branch: snapshot.branch,
        headOid: snapshot.headOid,
        remoteOid: snapshot.remoteOid,
        worktreeFingerprint: snapshot.worktreeFingerprint,
    };
    const planBody = {
        schemaVersion: 1,
        classification,
        preconditions,
        actions,
        risks,
        warnings,
        requiresConfirmation,
        ...(blockedBy === undefined ? {} : { blockedBy }),
    };
    return {
        ...planBody,
        planId: sha256(planBody),
    };
}
//# sourceMappingURL=planner.js.map