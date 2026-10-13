# FoW VPS connection through GitHub — read-only phase

## Status (14 Oct 2026)
- Live VPS has uncommitted changes, including `bot.js`. **Never reset, pull over, or deploy over those changes.**
- GitHub `main` is not a current bot source snapshot. An older baseline exists on `production-baseline-2026-09-27`.
- The GitHub repository is **PUBLIC**. Never upload credentials, .env files, runtime databases, or production files.
- The audit workflow is **not a deployment workflow**. It does not fix HS221 yet.

## One-time setup — Windows PC already able to SSH to the VPS
Get `FoW-GitHub-VPS-Remote-Setup.zip` from the ChatGPT conversation, extract it, and run `RUN-REMOTE-SETUP.cmd` on that PC. You may be asked to authenticate with the existing VPS account and to sign in to GitHub with a browser.

The installer:
1. Reuses the PC's **already trusted host-key record**. It refuses to trust an unverified SSH host key automatically.
2. Generates a NEW dedicated key, not the existing root/PC key.
3. Creates an unprivileged `fow-audit` account with no sudo, and an SSH key restricted to a **forced, fixed read-only command**.
4. Verifies the local SSH audit, then creates four repository Actions secrets using GitHub CLI:
   - `FOW_VPS_HOST`
   - `FOW_VPS_USER`
   - `FOW_VPS_SSH_PRIVATE_KEY`
   - `FOW_VPS_SSH_KNOWN_HOSTS`

## Audits from chat without Work/Codex
The workflow `.github/workflows/fow-vps-audit.yml` is callable either:
- Manually using GitHub Actions, or
- Automatically when a trusted actor creates a file under `audit-requests/` on `main`.

This makes it possible for the connected GitHub app in ChatGPT to start an audit by committing a harmless request file, after secrets are configured. The workflow sends a sanitized result to [issue #41](https://github.com/getsuga5546-cloud/FoW-ChatGPT-Bridge/issues/41), which ChatGPT can read through the GitHub app.

**Security:** No arbitrary shell command is taken from `audit-requests` or from GitHub. The server SSH key runs only the fixed audit script. Repo secrets are not published and are unavailable in the workflow's output. Audit comments are PUBLIC; do not add private data.

## Future change/deploy phase (not yet built)
After verifying current VPS code, reconcile the dirty working tree into a **PRIVATE** source repository before considering patches or deploy. Any deployment system needs explicit approval, a pre-change backup, SHA/dirty-tree safeguards, local tests, and an isolated restart of only `fow-elo-bot`. Keep War Control, timers, Supabase, and active Match IDs intact.

**HS221** requires a separate surgical data/timer correction and verification; do not use `/cancel_timer` or `war_override` blindly because those actions may remove isolation.
