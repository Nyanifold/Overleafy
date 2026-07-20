---
name: overleafy-guide
description: Manage and operate Overleaf documents through the overleafy CLI, including credential profiles, project discovery, cloning or binding repositories, local LaTeX file editing, status inspection, plan-reviewed pull/push/two-way synchronization, conflict recovery, history-rewrite handling, self-hosted Overleaf, and CI automation. Use when Codex needs to inspect, download, modify, synchronize, troubleshoot, recover, bind, or unbind an Overleaf project with overleafy.
---

# Manage Overleaf Documents with Overleafy

Treat the local Git worktree as the document editing surface and Overleaf as the bound remote. Use `overleafy` for authentication, binding, synchronization, and recovery; use normal file tools to inspect or edit `.tex`, `.bib`, figures, and other project files.

## Establish context

1. Run `overleafy --version` and `overleafy --help`. If working from this source repository without a global binary, build first and use `npm run cli -- --help`, then replace `overleafy` below with `npm run cli -- --`.
2. Locate the repository with `git rev-parse --show-toplevel`. Most repository commands accept `--repo <path>` and otherwise start from the current directory.
3. Run `overleafy status` before changing or synchronizing a bound project.
4. Read [references/commands.md](references/commands.md) when selecting flags, authenticating, binding, resolving conflicts, using JSON, or diagnosing an error.
5. Inspect `.overleafy/config.json` only when binding details matter. Never place credentials in that file, Git remote URLs, prompts, logs, or commits.

## Choose the workflow

- For a new local checkout, authenticate, create an empty target directory, then run `overleafy clone <project-id-or-url> --dir <path>`.
- For an existing Git repository, run `overleafy bind --project <id-or-url> --plan-only`, inspect the plan, then repeat with the exact `--plan-id`.
- To edit a document, modify local project files with normal tools, inspect the diff, and synchronize only after the edit is complete.
- For routine two-way synchronization, prefer the review flow: run `overleafy plan`, inspect classification/actions/blockers, then run `overleafy sync --plan-id <id>` with identical policy flags.
- Use `pull` only when the user explicitly wants remote-to-local changes and `push` only for local-to-remote changes. Neither is a substitute for reviewing divergence.
- For automation, add global `--json`, parse the single versioned JSON document, and use `OVERLEAFY_GIT_TOKEN` rather than persisting a CI token.

## Edit and synchronize safely

1. Inspect `git status --short`, relevant source files, and `git diff`.
2. Pull or synchronize before editing when collaborators may have changed the Overleaf copy.
3. Apply the requested local file edits. Do not edit `.overleafy/state.json` or remove `.overleafy/lock` manually.
4. Run relevant local validation when available, such as the repository's LaTeX build or lint command. Do not claim Overleaf compilation succeeded unless it was actually observed; overleafy itself synchronizes files and does not compile them.
5. Review `git diff --check` and the content diff.
6. Run `overleafy plan --dirty-policy checkpoint --message "<specific message>"`.
7. Inspect the classification, every action, and any blocker. A plan is state-bound and may become stale after local or remote changes.
8. Apply the reviewed plan with `overleafy sync --plan-id <id> --dirty-policy checkpoint --message "<same message>"`.
9. Run `overleafy status` and `git status --short`; report the resulting commit/state and any unresolved warnings.

Prefer a meaningful checkpoint message. Although `sync` defaults to checkpointing dirty files, make the policy explicit in reviewed workflows. Do not choose `stash` for a full two-way sync: the current planner rejects it.

## Guard destructive decisions

Stop and obtain explicit user direction before handling `remote_rewritten`.

- `--rewrite-policy remote` creates a local backup ref and resets local history to the rewritten Overleaf history. Local commits can disappear from the current branch.
- `--rewrite-policy local --confirm-rewrite` creates a remote backup ref and force-pushes local history with a lease. Overleaf history changes.

First show the relevant log/plan and explain which side becomes authoritative. Never infer a rewrite policy. Preserve `refs/overleafy/backup/` until the user verifies recovery.

Use plan-only flows before binding replacement or unbinding. `unbind` removes the Overleaf remote and `.overleafy` binding/state configuration; it does not delete ordinary document files.

## Recover conflicts

1. Run `overleafy conflicts list`.
2. Inspect each file and its Git stages. Resolve manually when content must be combined.
3. Use `overleafy conflicts resolve --path <exact-path> --use ours|theirs` only when one whole side is intentionally authoritative. In this merge, `ours` is local and `theirs` is the fetched Overleaf side.
4. Run the conflict list again.
5. Run `overleafy conflicts continue` only after no unresolved paths remain; it commits and pushes with the saved lease.
6. Use `overleafy conflicts abort` to abandon the operation and restore its local backup.

Never start another sync while an operation is active.

## Report outcomes

State which repository/project was operated on, which files changed, which plan actions ran, whether local and remote commits now match, and whether compilation was tested. Redact tokens, cookies, CSRF values, and credential-bearing environment output.
