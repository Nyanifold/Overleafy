import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical.js";
import { OverleafyError } from "./error.js";
import { planSync } from "./planner.js";
import { RESULT_SCHEMA_VERSION, } from "./types.js";
class RandomOperationIds {
    next() {
        return `op_${randomUUID()}`;
    }
}
export class SyncService {
    repositories;
    bindings;
    execution;
    operationIds;
    constructor(repositories, bindings, execution, operationIds = new RandomOperationIds()) {
        this.repositories = repositories;
        this.bindings = bindings;
        this.execution = execution;
        this.operationIds = operationIds;
    }
    async status(repositoryPath) {
        const binding = await this.bindings.read(repositoryPath);
        const state = await this.execution?.states.read(repositoryPath);
        const observation = await this.repositories.inspect(repositoryPath, binding, {
            fetch: false,
        });
        return this.result({
            bound: binding !== undefined,
            ...(binding === undefined ? {} : { binding }),
            snapshot: observation.snapshot,
            ...(state?.activeOperation === undefined
                ? {}
                : { activeOperation: state.activeOperation }),
        });
    }
    async plan(repositoryPath, options) {
        const binding = await this.requireBinding(repositoryPath);
        const state = await this.execution?.states.read(repositoryPath);
        const observation = await this.repositories.inspect(repositoryPath, binding, {
            fetch: true,
            ...(state?.lastSuccessfulSync?.remoteOid === undefined
                ? {}
                : { lastRemoteOid: state.lastSuccessfulSync.remoteOid }),
        });
        this.validateLocalBranch(binding, observation.snapshot.branch);
        return this.result(planSync(observation, options), "ok");
    }
    async apply(repositoryPath, planId, options) {
        if (this.execution === undefined) {
            throw new OverleafyError("INTERNAL", "Sync execution services are not configured.");
        }
        const binding = await this.requireBinding(repositoryPath);
        const state = await this.execution.states.read(repositoryPath);
        if (state.activeOperation !== undefined) {
            throw new OverleafyError("OPERATION_IN_PROGRESS", `Operation ${state.activeOperation.operationId} is already active.`, {
                remediation: "Inspect, continue, or abort the active operation before applying another plan.",
            });
        }
        const initialObservation = await this.repositories.inspect(repositoryPath, binding, {
            fetch: true,
            ...(state.lastSuccessfulSync?.remoteOid === undefined
                ? {}
                : { lastRemoteOid: state.lastSuccessfulSync.remoteOid }),
        });
        this.validateLocalBranch(binding, initialObservation.snapshot.branch);
        const initialPlan = planSync(initialObservation, options);
        this.validatePlan(planId, initialPlan, options);
        const operationId = this.operationIds.next();
        const repositoryRoot = initialObservation.snapshot.repositoryPath;
        const lock = await this.execution.locks.acquire(repositoryRoot, operationId);
        const mergeAction = initialPlan.actions.find((action) => action.type === "merge");
        const pushAction = initialPlan.actions.find((action) => action.type === "push");
        const activeOperation = {
            operationId,
            planId,
            phase: "applying",
            startedAt: new Date().toISOString(),
            ...(mergeAction?.type === "merge"
                ? { mergeTargetOid: mergeAction.oid }
                : {}),
            ...(pushAction?.type === "push" &&
                pushAction.expectedRemoteOid !== null
                ? { expectedRemoteOid: pushAction.expectedRemoteOid }
                : {}),
        };
        await this.execution.states.write(repositoryRoot, {
            ...state,
            activeOperation,
        });
        try {
            const lockedObservation = await this.repositories.inspect(repositoryRoot, binding, {
                fetch: true,
                ...(state.lastSuccessfulSync?.remoteOid === undefined
                    ? {}
                    : { lastRemoteOid: state.lastSuccessfulSync.remoteOid }),
            });
            this.validateLocalBranch(binding, lockedObservation.snapshot.branch);
            const lockedPlan = planSync(lockedObservation, options);
            this.validatePlan(planId, lockedPlan, options);
            await this.repositories.apply(repositoryRoot, binding, lockedPlan, operationId);
            const finalObservation = await this.repositories.inspect(repositoryRoot, binding, { fetch: true });
            const { headOid, remoteOid } = finalObservation.snapshot;
            if (headOid === null || remoteOid === null || headOid !== remoteOid) {
                throw new OverleafyError("REMOTE_MOVED", "Post-sync verification did not observe equal local and remote commits.", {
                    remediation: "Create a new plan; do not repeat the previous apply request.",
                    details: { headOid, remoteOid },
                });
            }
            await this.execution.states.write(repositoryRoot, {
                schemaVersion: 1,
                lastSuccessfulSync: {
                    localOid: headOid,
                    remoteOid,
                    at: new Date().toISOString(),
                },
            });
            return {
                schemaVersion: RESULT_SCHEMA_VERSION,
                operationId,
                status: lockedPlan.actions.length === 0 ? "noop" : "ok",
                warnings: lockedPlan.warnings,
                data: {
                    planId,
                    classification: lockedPlan.classification,
                    appliedActions: lockedPlan.actions.map((action) => action.type),
                    headOid,
                    remoteOid,
                },
            };
        }
        catch (error) {
            const details = error instanceof OverleafyError
                ? error.details
                : {
                    code: "INTERNAL",
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false,
                };
            if (details.code === "CONFLICT") {
                await this.execution.states.write(repositoryRoot, {
                    ...state,
                    activeOperation: {
                        ...activeOperation,
                        phase: "conflict",
                        errorCode: details.code,
                    },
                });
            }
            else {
                await this.execution.states.write(repositoryRoot, state);
            }
            throw error;
        }
        finally {
            await lock.release();
        }
    }
    async bind(repositoryPath, binding) {
        const resolvedRepositoryPath = await this.repositories.bind(repositoryPath, binding);
        await this.bindings.write(resolvedRepositoryPath, binding);
        return this.result(binding);
    }
    async planBinding(repositoryPath, binding) {
        const existing = await this.bindings.read(repositoryPath);
        if (existing !== undefined &&
            sha256(existing) !== sha256(binding)) {
            throw new OverleafyError("BINDING_INVALID", "The worktree is already bound to a different Overleaf project or configuration.", {
                remediation: "Inspect and remove the existing binding explicitly before replacing it.",
                details: {
                    existingProjectId: existing.projectId,
                    requestedProjectId: binding.projectId,
                },
            });
        }
        const observation = await this.repositories.inspect(repositoryPath, undefined, { fetch: false });
        this.validateLocalBranch(binding, observation.snapshot.branch);
        const preconditions = {
            repositoryPath: observation.snapshot.repositoryPath,
            branch: observation.snapshot.branch,
            headOid: observation.snapshot.headOid,
            worktreeFingerprint: observation.snapshot.worktreeFingerprint,
        };
        const body = {
            schemaVersion: 1,
            binding,
            preconditions,
            actions: existing === undefined
                ? [
                    "add_or_validate_remote",
                    "write_binding",
                ]
                : [],
            alreadyBound: existing !== undefined,
        };
        return this.result({
            ...body,
            planId: sha256(body),
        });
    }
    async applyBinding(repositoryPath, binding, planId) {
        const planned = await this.planBinding(repositoryPath, binding);
        if (planned.data.planId !== planId) {
            throw new OverleafyError("PLAN_STALE", "The repository or binding changed after the binding plan was created.", {
                remediation: "Create and inspect a new binding plan.",
                details: {
                    expectedPlanId: planId,
                    actualPlanId: planned.data.planId,
                },
            });
        }
        if (planned.data.alreadyBound) {
            return this.result({
                planId,
                projectId: binding.projectId,
                remoteName: binding.remoteName,
                remoteBranch: binding.remoteBranch,
                alreadyBound: true,
            }, "noop");
        }
        const operationId = this.operationIds.next();
        const root = planned.data.preconditions.repositoryPath;
        const lock = await this.execution?.locks.acquire(root, operationId);
        try {
            const lockedPlan = await this.planBinding(root, binding);
            if (lockedPlan.data.planId !== planId) {
                throw new OverleafyError("PLAN_STALE", "The repository or binding changed while acquiring the lock.", { remediation: "Create and inspect a new binding plan." });
            }
            const resolvedRoot = await this.repositories.bind(root, binding);
            await this.bindings.write(resolvedRoot, binding);
            return {
                schemaVersion: RESULT_SCHEMA_VERSION,
                operationId,
                status: "ok",
                warnings: [],
                data: {
                    planId,
                    projectId: binding.projectId,
                    remoteName: binding.remoteName,
                    remoteBranch: binding.remoteBranch,
                    alreadyBound: false,
                },
            };
        }
        finally {
            await lock?.release();
        }
    }
    async planUnbind(repositoryPath) {
        const binding = await this.bindings.read(repositoryPath);
        if (binding === undefined) {
            throw new OverleafyError("BINDING_INVALID", "This repository is not bound to any Overleaf project.", { remediation: "No unbind action is necessary." });
        }
        const body = {
            schemaVersion: 1,
            projectId: binding.projectId,
            remoteName: binding.remoteName,
            actions: ["remove_remote", "delete_config"],
        };
        return this.result({
            ...body,
            planId: sha256(body),
        });
    }
    async applyUnbind(repositoryPath, planId) {
        const planned = await this.planUnbind(repositoryPath);
        if (planned.data.planId !== planId) {
            throw new OverleafyError("PLAN_STALE", "The repository binding changed after the unbind plan was created.", { remediation: "Create and inspect a new unbind plan." });
        }
        const binding = await this.bindings.read(repositoryPath);
        if (binding === undefined) {
            return this.result({
                planId,
                projectId: planned.data.projectId,
                remoteName: planned.data.remoteName,
                remoteRemoved: false,
                configDeleted: false,
            }, "noop");
        }
        const operationId = this.operationIds.next();
        const root = await this.repositories.inspect(repositoryPath, binding, { fetch: false });
        const lock = await this.execution?.locks.acquire(root.snapshot.repositoryPath, operationId);
        try {
            await this.repositories.unbind(root.snapshot.repositoryPath, binding.remoteName);
            await this.bindings.delete(root.snapshot.repositoryPath);
            return {
                schemaVersion: RESULT_SCHEMA_VERSION,
                operationId,
                status: "ok",
                warnings: [],
                data: {
                    planId,
                    projectId: binding.projectId,
                    remoteName: binding.remoteName,
                    remoteRemoved: true,
                    configDeleted: true,
                },
            };
        }
        finally {
            await lock?.release();
        }
    }
    async conflicts(repositoryPath) {
        const active = await this.requireConflictOperation(repositoryPath);
        const binding = await this.bindings.read(repositoryPath);
        const observation = await this.repositories.inspect(repositoryPath, binding, { fetch: false });
        return this.result({
            operationId: active.operationId,
            gitOperation: observation.snapshot.operation,
            files: await this.repositories.listConflicts(observation.snapshot.repositoryPath),
        });
    }
    async resolveConflict(repositoryPath, filePath, resolution, expectedOperationId) {
        const execution = this.requireExecution();
        const active = await this.requireConflictOperation(repositoryPath);
        this.validateOperationId(expectedOperationId, active.operationId);
        const binding = await this.requireBinding(repositoryPath);
        const observation = await this.repositories.inspect(repositoryPath, binding, { fetch: false });
        this.validateLocalBranch(binding, observation.snapshot.branch);
        const root = observation.snapshot.repositoryPath;
        const lock = await execution.locks.acquire(root, active.operationId);
        try {
            const lockedActive = await this.requireConflictOperation(root);
            if (lockedActive.operationId !== active.operationId) {
                throw new OverleafyError("OPERATION_IN_PROGRESS", "The active conflict operation changed while acquiring the lock.");
            }
            await this.repositories.resolveConflict(root, filePath, resolution);
            return this.result({
                operationId: active.operationId,
                path: filePath,
                resolution,
                remaining: await this.repositories.listConflicts(root),
            });
        }
        finally {
            await lock.release();
        }
    }
    async continueConflict(repositoryPath, expectedOperationId) {
        const execution = this.requireExecution();
        const binding = await this.requireBinding(repositoryPath);
        const active = await this.requireConflictOperation(repositoryPath);
        this.validateOperationId(expectedOperationId, active.operationId);
        if (active.mergeTargetOid === undefined ||
            active.expectedRemoteOid === undefined) {
            throw new OverleafyError("OPERATION_IN_PROGRESS", "The active conflict predates recoverable sync state.", {
                remediation: "Abort this operation, then create and apply a new sync plan.",
            });
        }
        const observation = await this.repositories.inspect(repositoryPath, binding, { fetch: false });
        this.validateLocalBranch(binding, observation.snapshot.branch);
        const root = observation.snapshot.repositoryPath;
        const lock = await execution.locks.acquire(root, active.operationId);
        try {
            const lockedActive = await this.requireConflictOperation(root);
            if (lockedActive.operationId !== active.operationId) {
                throw new OverleafyError("OPERATION_IN_PROGRESS", "The active conflict operation changed while acquiring the lock.");
            }
            await this.repositories.continueConflict(root, binding, active.mergeTargetOid, active.expectedRemoteOid);
            const finalObservation = await this.repositories.inspect(root, binding, {
                fetch: true,
            });
            const { headOid, remoteOid } = finalObservation.snapshot;
            if (headOid === null || remoteOid === null || headOid !== remoteOid) {
                throw new OverleafyError("REMOTE_MOVED", "Conflict continuation could not verify equal local and remote commits.", { remediation: "Inspect the active operation and retry continuation." });
            }
            await execution.states.write(root, {
                schemaVersion: 1,
                lastSuccessfulSync: {
                    localOid: headOid,
                    remoteOid,
                    at: new Date().toISOString(),
                },
            });
            return {
                schemaVersion: RESULT_SCHEMA_VERSION,
                operationId: active.operationId,
                status: "ok",
                warnings: [],
                data: {
                    operationId: active.operationId,
                    headOid,
                    remoteOid,
                },
            };
        }
        finally {
            await lock.release();
        }
    }
    async abortConflict(repositoryPath, expectedOperationId) {
        const execution = this.requireExecution();
        const active = await this.requireConflictOperation(repositoryPath);
        this.validateOperationId(expectedOperationId, active.operationId);
        const binding = await this.bindings.read(repositoryPath);
        const observation = await this.repositories.inspect(repositoryPath, binding, { fetch: false });
        const root = observation.snapshot.repositoryPath;
        const lock = await execution.locks.acquire(root, active.operationId);
        try {
            const lockedActive = await this.requireConflictOperation(root);
            if (lockedActive.operationId !== active.operationId) {
                throw new OverleafyError("OPERATION_IN_PROGRESS", "The active conflict operation changed while acquiring the lock.");
            }
            await this.repositories.abortConflict(root, active.operationId);
            const finalObservation = await this.repositories.inspect(root, binding, {
                fetch: false,
            });
            const state = await execution.states.read(root);
            await execution.states.write(root, {
                ...state,
                activeOperation: undefined,
            });
            return this.result({
                operationId: active.operationId,
                headOid: finalObservation.snapshot.headOid,
            });
        }
        finally {
            await lock.release();
        }
    }
    async requireBinding(repositoryPath) {
        const binding = await this.bindings.read(repositoryPath);
        if (binding === undefined) {
            throw new OverleafyError("BINDING_INVALID", "The repository is not bound to an Overleaf project.", {
                remediation: "Run overleafy bind first.",
            });
        }
        return binding;
    }
    requireExecution() {
        if (this.execution === undefined) {
            throw new OverleafyError("INTERNAL", "Sync execution services are not configured.");
        }
        return this.execution;
    }
    async requireConflictOperation(repositoryPath) {
        const execution = this.requireExecution();
        const state = await execution.states.read(repositoryPath);
        if (state.activeOperation === undefined ||
            state.activeOperation.phase !== "conflict") {
            throw new OverleafyError("OPERATION_IN_PROGRESS", "There is no active sync conflict to inspect or recover.");
        }
        return state.activeOperation;
    }
    validatePlan(expectedPlanId, actualPlan, options) {
        if (actualPlan.planId !== expectedPlanId) {
            throw new OverleafyError("PLAN_STALE", "The repository or remote changed after the plan was created.", {
                remediation: "Create a new sync plan and inspect it before applying.",
                details: {
                    expectedPlanId,
                    actualPlanId: actualPlan.planId,
                },
            });
        }
        if (actualPlan.blockedBy !== undefined) {
            throw new OverleafyError(actualPlan.blockedBy.code, actualPlan.blockedBy.message, {
                retryable: actualPlan.blockedBy.retryable,
                ...(actualPlan.blockedBy.remediation === undefined
                    ? {}
                    : { remediation: actualPlan.blockedBy.remediation }),
            });
        }
        if (actualPlan.requiresConfirmation && options.confirmation !== true) {
            throw new OverleafyError("REMOTE_REWRITTEN", "This plan requires explicit confirmation.", {
                remediation: "Review backup and rewrite actions, then apply with confirmation=true.",
            });
        }
    }
    validateLocalBranch(binding, actualBranch) {
        if (actualBranch !== binding.localBranch) {
            throw new OverleafyError("BINDING_INVALID", `The worktree is on '${actualBranch ?? "detached HEAD"}', not the bound branch '${binding.localBranch}'.`, {
                remediation: `Switch to '${binding.localBranch}' or create a separate binding for this worktree.`,
                details: {
                    expectedBranch: binding.localBranch,
                    actualBranch,
                },
            });
        }
    }
    validateOperationId(expectedOperationId, actualOperationId) {
        if (expectedOperationId !== undefined &&
            expectedOperationId !== actualOperationId) {
            throw new OverleafyError("PLAN_STALE", "The active conflict operation changed after it was inspected.", {
                remediation: "List conflicts again and use the returned operation ID.",
                details: { expectedOperationId, actualOperationId },
            });
        }
    }
    result(data, status = "ok") {
        return {
            schemaVersion: RESULT_SCHEMA_VERSION,
            operationId: this.operationIds.next(),
            status,
            warnings: [],
            data,
        };
    }
}
//# sourceMappingURL=service.js.map