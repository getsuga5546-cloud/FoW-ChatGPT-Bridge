# Deployment checks

Run `npm test` for regression tests or `bash deploy-dev.sh --check-local` to validate the working-tree release bundle without fetching or restarting.

Before deployment, commit the runtime modules, tests, `deploy-files.txt`, package files and deployment script to the `dev` branch. Untracked local files are not included in a remote release.

Run `bash deploy-dev.sh` to fetch and pin the current `dev` commit, validate its manifest, syntax and tests, back up every replaced file and restart PM2. The script restores those files if installation, restart or the 15-second process stability check fails. Backups are under `deploy-backups/release.*`. This check confirms process stability; Discord readiness and database persistence still need live verification. Rollback covers files, not database or runtime-state changes made during startup.

Dependency changes are deliberately blocked by this deployment path. They require a separately prepared dependency release. The script reuses the current node_modules installation during validation and deployment.

# Live verification record

No live verification is recorded by this change. Fill in commit, date, tester and result for each scenario:

| Scenario | Commit / date / tester | Result |
| --- | --- | --- |
| Saved failed result → preparation; partner released; successful clubs preserved | — | Pending |
| High Set War Chat chooses correct match; ordinary chat ignored | — | Pending |
| ADD PAIR preview → confirm → persistence | — | Pending |
| WAR END preview → confirm → intended clubs released | — | Pending |
| Stop event → start next event; existing timers continue | — | Pending |
| Long war override preview attachment → confirm | — | Pending |
| Restart → restore timers with original deadlines | c94a05b / 2026-09-30 / automated SSH verification | PASS: all 3 IDs and start/end times unchanged |

## Production smoke check — 2026-09-30 11:12 UTC

Validated the existing production working tree with `bash deploy-dev.sh --check-local`: 24 test cases passed across 11 test files on the server. Restarted the existing version via PM2. PID 520942 remained unchanged at the 18-second follow-up. Logs confirmed Discord shard ready, bot online, slash commands registered and timer processor running with 3 active timers. Error log last modified 2026-09-29 16:17 UTC, before this restart.

Runtime bot.js SHA-256: `2ad5541bfdb6e2cd00672a306a389d38931e43c383ff5372e666a12f6930cf80`.

This verifies startup of the existing working tree, not deployment from origin/dev. No before/after timer deadline comparison or live Discord control interaction was performed; those checks remain pending.

## Deployment from dev — 2026-09-30 11:14 UTC

Deployed `c94a05b2521bb36b6c916b04b4bdbe3e10ebde03` using `bash deploy-dev.sh`. All 24 server test cases passed. Backup: `/opt/fow-elo-bot/deploy-backups/release.NSInI0`. PM2 PID 521951 remained stable throughout the deployment check. `/health` reported healthy, Discord online, database OK, Supabase connected and 82 clubs. Error log remained unchanged since September 29.

Compared the saved timer list immediately before deployment with the post-restart file: all 3 timer IDs, match IDs, start times and end times are identical. Discord startup logs also confirmed 3 active timers.

Live Discord button interactions remain unverified: this session has no user-account interaction tool, and a test channel / dummy Match ID has been requested. Existing automated handler tests passed; they do not substitute for real Discord clicks.
