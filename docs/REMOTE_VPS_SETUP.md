# FoW VPS connection through GitHub (read-only first)

## Current state (14 Oct 2026)
- A **public** GitHub repository is connected as `origin` to the live VPS.
- Live working copy: `/opt/fow-elo-bot`, local branch `codex/batch-war-done-release` at commit `22903a5`.
- Live tree contains **modified and untracked files**, including `bot.js` and deployment helper files. Do not overwrite or pull over these changes.
- Older production code is present on the GitHub branch `production-baseline-2026-09-27`; it is **not** a verified current snapshot.

## What this change provides
`.github/workflows/fow-vps-audit.yml` is a **manual, read-only** GitHub Actions SSH connection test. It lists current code state, hashes `bot.js`, and runs `node --check bot.js`. It does not deploy, pull, push, commit, restart PM2, or edit files.

## One-time steps required before running
1. Review and merge this PR after checking the workflow. A workflow dispatched from the GitHub Actions UI must exist on the repository default branch.
2. Configure four repository Actions secrets (never commit their values): `FOW_VPS_HOST`, `FOW_VPS_USER`, `FOW_VPS_SSH_PRIVATE_KEY`, and `FOW_VPS_SSH_KNOWN_HOSTS`. The `KNOWN_HOSTS` entry must be independently verified against the VPS server's SSH host-key fingerprint; **do not blindly trust ssh-keyscan**.
3. Prefer a **dedicated, non-root, read-only SSH identity**. Authorize only its public key on the VPS. Do not upload the personal PC SSH private key or a general-purpose root private key.
4. In GitHub Actions, manually dispatch `FoW VPS SSH audit (read-only)`. Review the result. Nothing will change on the VPS.

## Next phase (NOT implemented here)
A separate deployment flow can be designed only after (a) reading existing live `DEPLOYMENT.md` and `deploy-dev.sh`, (b) backing up the current live working tree, (c) ensuring sensitive runtime/state files are excluded, and (d) reconciling the **dirty** live code with a verified private source repository. The deployment flow must use explicit approval, exact SHA preconditions, syntax/tests, a rollback backup, and a controlled restart of `fow-elo-bot` only.

**Security:** The current GitHub repository is public. Do not publish production secrets, .env files, Discord tokens, database credentials, or a private key. A manual read-only test is not remote administration, and GitHub Actions is not a substitute for interactive SSH.
