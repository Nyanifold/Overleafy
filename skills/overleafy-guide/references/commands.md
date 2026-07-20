# Overleafy command reference

Use this reference for concrete command construction. Confirm behavior with the installed version's `--help` when it differs.

## Authentication and project discovery

```bash
overleafy auth set-git-token --profile work
overleafy auth import-cookie --profile work
overleafy auth import-cookie --profile work --cookie-file /secure/path/cookies.txt
overleafy auth status --profile work
overleafy projects list --profile work
```

The Git token supports Git fetch/push. A browser cookie is needed to list projects and for clone's ZIP fallback. Secret input without `--cookie-file` is hidden. Cookie files must be regular files with mode `0600`. A raw cookie value is normalized to `overleaf_session2=<value>`.

Profiles accept letters, numbers, dot, underscore, and hyphen. Stored credentials live in `~/.overleaf_config.json` with mode `0600` in the current implementation. `OVERLEAFY_GIT_TOKEN` takes priority for Git authentication and is not persisted.

Do not put a token or cookie directly on a command line. Avoid printing credential files or environment variables.

## Git identity, clone, and binding

```bash
overleafy config --name "Name" --email "name@example.com" --repo /path/to/repo

overleafy clone <project-id-or-url> \
  --dir /empty/target \
  --profile work \
  --remote overleaf \
  --remote-branch main

overleafy bind --project <project-id-or-url> --repo /path/to/repo --plan-only
overleafy bind --project <project-id-or-url> --repo /path/to/repo --plan-id <id>

overleafy unbind --repo /path/to/repo --plan-only
overleafy unbind --repo /path/to/repo --plan-id <id>
```

`clone` initializes Git, creates local branch `main`, binds the project, tries a Git pull, and then tries a browser-cookie ZIP download if no Git content was pulled. Its target must be empty except for an optional `.git`.

`bind` accepts `--project-name`, `--profile`, `--web-url`, `--git-url`, `--remote`, `--local-branch`, and `--remote-branch`. It refuses a detached HEAD unless `--local-branch` is supplied and refuses silently replacing a different binding. Preserve all binding flags between plan and apply because they contribute to the plan identity.

The current CLI defaults `--remote-branch` to `main`; confirm with `overleafy bind --help` or `clone --help` rather than assuming an Overleaf-wide branch name. Binding configuration is stored at `.overleafy/config.json`.

For self-hosted installations, set both service endpoints as needed:

```bash
overleafy clone <project> \
  --web-url https://overleaf.example.org \
  --git-url https://git.overleaf.example.org/<project>
```

URLs must use HTTP or HTTPS and must not contain embedded credentials.

## Status, planning, and synchronization

```bash
overleafy status --repo /path/to/repo
overleafy plan --repo /path/to/repo \
  --dirty-policy fail|checkpoint|stash \
  --rewrite-policy fail|remote|local \
  --message "checkpoint message"
overleafy sync --repo /path/to/repo \
  --plan-id <id> \
  --dirty-policy checkpoint \
  --rewrite-policy fail \
  --message "checkpoint message"

overleafy pull --repo /path/to/repo
overleafy push --repo /path/to/repo
```

`plan` defaults to `dirty-policy=fail` and `rewrite-policy=fail`. `sync` defaults to `dirty-policy=checkpoint` and `rewrite-policy=fail`. `pull` and `push` internally use checkpoint/fail policies and expose no plan or policy flags.

Classifications and normal implications:

| Classification | Meaning | Typical action |
| --- | --- | --- |
| `equal_clean` | Commits and worktree agree | none |
| `equal_dirty` | Commits agree; local files changed | checkpoint, push |
| `local_ahead` | Local has commits | push |
| `remote_ahead` | Overleaf has commits | fast-forward if clean; otherwise checkpoint, backup, merge, push |
| `diverged` | Both sides have commits | checkpoint if needed, backup, merge, push |
| `remote_rewritten` | Remote no longer descends from last observed remote | block until an explicit rewrite policy |
| `operation_in_progress` | Merge/conflict or another operation exists | continue or abort it |
| `unborn` | One or both sides have no commits | initialize the missing side when possible |
| `invalid` | Usually detached or wrong branch | switch to the configured named branch |

Plan IDs hash preconditions and selected policies. If the worktree, branch, remote, or flags change, create a new plan rather than retrying a stale ID.

`checkpoint` includes staged, unstaged, and untracked in-scope paths. Changes outside the configured sync scope block synchronization. The default scope includes everything except `.git/**`, `.overleafy/**`, and `.output/**`.

## Remote history rewrites

Preview before acting:

```bash
overleafy plan --rewrite-policy remote
overleafy plan --rewrite-policy local
```

After explicit user authorization, apply the chosen reviewed plan:

```bash
overleafy sync --plan-id <id> --rewrite-policy remote --confirm-rewrite
overleafy sync --plan-id <id> --rewrite-policy local --confirm-rewrite
```

`remote` means accept Overleaf as authoritative and reset the local branch after creating a local backup ref. `local` means accept local history as authoritative and force-push with lease after creating a remote backup ref. Both require confirmation at apply time.

## Conflict recovery

```bash
overleafy conflicts list --repo /path/to/repo
overleafy conflicts resolve --repo /path/to/repo \
  --path main.tex --use ours
overleafy conflicts continue --repo /path/to/repo
overleafy conflicts abort --repo /path/to/repo
```

Use the exact path returned by `conflicts list`. `continue` refuses unresolved paths, commits the merge, pushes using the saved expected remote commit, verifies equality, and clears the operation state. `abort` restores the saved local backup.

## Structured output and common errors

Place global `--json` before or after subcommands as supported by Commander, for example:

```bash
overleafy --json status
overleafy --json plan --dirty-policy fail
```

Successful output includes `schemaVersion`, `operationId`, `status`, `warnings`, and `data`. Errors include `schemaVersion`, `status: "error"`, and an `error` object with `code`, `message`, `retryable`, and sometimes `remediation`/`details`.

Handle these codes by following their remediation rather than blindly retrying:

- `AUTH_REQUIRED`: configure/unlock credentials or refresh the browser cookie.
- `BINDING_INVALID`: inspect project ID/URL, branch, binding, and command flags.
- `DIRTY_WORKTREE`: inspect paths; commit or use checkpoint.
- `CONFLICT`: list, resolve, continue, or abort.
- `PLAN_STALE` / `REMOTE_MOVED`: fetch and create a new plan.
- `REMOTE_REWRITTEN`: inspect history and ask which side is authoritative.
- `OPERATION_IN_PROGRESS`: recover the active operation first.
- `LOCKED`: wait for the owner; do not manually delete the lock without diagnosis.

The source mentions a future `doctor` command in some remediation strings, but the current CLI does not implement it. Diagnose with `status`, Git inspection, `.overleafy/state.json`, and process ownership; do not invent or run `overleafy doctor`.
