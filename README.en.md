# Overleafy

[中文](README.md)

Bidirectional sync between a local Git worktree and an Overleaf project.
One command to sync — with backups, rollback, and diagnostics built in.

> ⚠️ This project is heavily Vibe Coded. Expect unexpected behavior from time to time.
> If you hit a bug, please open an [Issue](https://github.com/Nyanifold/overleafy/issues).
>
> ⚠️ Multi-party edit validation is not yet fully implemented. If you edit the same file
> on both Overleaf and locally, double-check the merge result before pushing to avoid
> accidentally losing changes.

Author: [**Nyanifold**](https://github.com/Nyanifold)

## Install

```bash
npm install --global @nyanifold/overleafy
```

Prerequisites: Node.js ≥ 22.14, a modern version of Git, and an Overleaf account with Git Integration enabled.

## Tutorial

### Step 1: Credentials

Overleafy needs two credentials: a Git Token for push/pull, and a Cookie for listing projects and downloading files.

**Git Token** (required for everyone) — from Overleaf: **Account** (bottom-left) → **Account Settings → Git Integration**:

```bash
overleafy auth set-git-token --profile work
# Paste the token, press Enter (input is hidden)
```

**Cookie** (SSO users with school/institutional accounts) — export your session from the browser after logging into Overleaf:

> **Chrome / Edge:** F12 → Application → Cookies → `overleaf.com` → copy the value of `overleaf_session`
> **Firefox:** F12 → Storage → Cookies → `overleaf.com` → same

```bash
# Option A: Save to file and import (recommended, avoids shell history leaks)
echo "overleaf_session2=..." > ~/overleaf-cookies.txt
chmod 600 ~/overleaf-cookies.txt
overleafy auth import-cookie --profile work --cookie-file ~/overleaf-cookies.txt

# Option B: TTY hidden input (no file needed, paste and press Enter)
overleafy auth import-cookie --profile work
```

If your cookie value already contains `=`, paste it as-is. If it's just a raw token, the tool auto-prepends `overleaf_session2=`. Multiple cookies can be separated by `; `.

Verify:

```bash
overleafy auth status --profile work
# Profile: work
# Git token: configured
# Browser Cookie: configured
```

### Step 2: Git Identity

Set your name and email (once per repository):

```bash
overleafy config --name "Your Name" --email "you@example.com"
```

### Step 3: Clone a Project

Find the Project ID from the Overleaf URL: it's the 24-character hex string after `/project/`.
Or browse all your projects with `overleafy projects list --profile work`.

```bash
mkdir my-paper && cd my-paper
overleafy clone 0123456789abcdef01234567 --profile work
```

`clone` does three things automatically:

1. `git init` — initializes a local repository
2. Binds the Overleaf project — adds an `overleaf` remote without touching your existing `origin`
3. Pulls content — first tries Git pull; if the remote has no Git history yet (new project),
   falls back to downloading the project ZIP from Overleaf via the stored cookie

If you already have a local Git repo, use `bind` instead:

```bash
overleafy bind 0123456789abcdef01234567 --profile work
```

All credentials (token, cookie) are stored in `~/.overleaf_config.json` (0600). They never
appear in `.git/config`, remote URLs, command output, or logs.

### Step 4: Daily Sync

```bash
overleafy sync     # Bidirectional: pull → merge → push
overleafy pull     # Only pull from Overleaf
overleafy push     # Only push to Overleaf
```

`sync` inspects both sides and chooses the right action automatically:

| State | Meaning | Action |
|-------|---------|--------|
| `equal` | Both sides identical | Nothing |
| `local_ahead` | Local has new commits | Push |
| `remote_ahead` | Overleaf has new commits | Fast-forward pull |
| `diverged` | Both sides have new commits | Merge; pause on conflict |
| `remote_rewritten` | Remote history was rewritten (e.g. Overleaf Restore) | Pause, requires policy |

If you prefer to review before executing: `overleafy plan`, then `overleafy sync --plan-id <id>`.
For everyday use, just `overleafy sync` — uncommitted local changes are auto-checkpointed.

### Step 5: Handling Conflicts

When a conflict occurs, sync preserves the full state for recovery:

```bash
overleafy conflicts list                          # List conflicted files
overleafy conflicts resolve --path main.tex --use ours   # Resolve one file
overleafy conflicts continue                      # Commit the merge and push
# or
overleafy conflicts abort                         # Abort and restore backup
```

### Step 6: Status

```bash
overleafy status              # Human-readable
overleafy status --json       # Structured JSON for scripts
```

### Other Commands

| Command | Description |
|---------|-------------|
| `overleafy projects list --profile work` | List Overleaf projects |
| `overleafy bind <id>` | Bind an existing repo to Overleaf |
| `overleafy bind <id> --plan-only` | Preview binding plan without applying |
| `overleafy unbind` | Remove Overleaf remote and binding config |
| `overleafy config --name "…" --email "…"` | Set Git identity for this repo |

All commands that accept `--repo <path>` can omit it — the tool walks up from the cwd to find the Git root.

### CI Environments

```bash
export OVERLEAFY_GIT_TOKEN="your-git-token"
```

This env var is never persisted and takes precedence over `~/.overleaf_config.json`.

### AI Agent Integration

This project ships an [overleafy-guide](skills/overleafy-guide/) skill that gives Claude Code, Codex, and other agents a complete CLI reference — covering auth, binding, plan-reviewed sync, conflict recovery, and error diagnostics.

## Security

- **Credential isolation**: Tokens and cookies live in `~/.overleaf_config.json` (0600).
  Git operations inject credentials via an ephemeral `GIT_ASKPASS` helper — never in `.git/config` or remote URLs.
- **Output redaction**: Logs and JSON output automatically scrub tokens, cookies, and CSRF tokens.
- **No shell injection**: All subprocesses use `execFile` with argument arrays, never shell strings.
- **No data loss**: Backup refs (`refs/overleafy/backup/`) are created before merging.
  Push is guarded by a remote lease check and a post-push verification fetch.
- **Destructive actions are explicit**: force-with-lease and accepting remote overwrites require an explicit policy flag.

## Self-Hosted Overleaf

```bash
overleafy clone <id> \
  --web-url https://overleaf.example.com \
  --git-url https://git.overleaf.example.com
```

## Architecture

```
src/
├── core/       # Domain model, state classification, planner
├── git/        # Git adapter (snapshot, fetch, merge, push)
├── overleaf/   # Overleaf adapter (Git remote, Cookie Web API)
├── config/     # Config, state locks, SecretStore
├── cli/        # overleafy CLI entry point
```

The core layer has no dependency on the filesystem, child processes, or terminal UI —
all external capabilities are injected through ports. The CLI is a thin parsing and serialization layer.

## Development

```bash
git clone https://github.com/Nyanifold/overleafy.git
cd overleafy
npm install
npm link
```

```bash
npm run check          # lint + build + test
npm run cli -- --help  # Run the CLI
```

## License

MIT
