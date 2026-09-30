#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
root=$PWD
mode=${1:-deploy}
[[ "$mode" == deploy || "$mode" == --check-local ]] || { echo 'Usage: deploy-dev.sh [--check-local]' >&2; exit 2; }
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
stage=$(mktemp -d /tmp/fow-release.XXXXXX)
backup=''
changed=0
files=()
cleanup() { rm -rf -- "$stage"; }
rollback() {
  local result=$?
  trap - ERR INT TERM
  if (( changed )); then
    echo "Deployment failed; restoring files from $backup" >&2
    for file in "${files[@]}"; do
      if [[ -f "$backup/$file" ]]; then
        cp -- "$backup/$file" "$root/$file" || true
      elif [[ -f "$backup/absent/$file" ]]; then
        rm -f -- "$root/$file" || true
      fi
    done
    pm2 restart fow-elo-bot || echo 'ROLLBACK RESTART FAILED: manual intervention required.' >&2
  fi
  exit "${result:-1}"
}
trap cleanup EXIT
trap rollback ERR
trap 'false' INT TERM
if [[ "$mode" == --check-local ]]; then
  cp deploy-files.txt deploy-dev.sh "$stage/"
  revision=working-tree
else
  git fetch origin dev
  revision=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
  git archive "$revision" | tar -x -C "$stage"
fi
[[ -f "$stage/deploy-files.txt" ]] || { echo 'Candidate has no release manifest.' >&2; exit 1; }
while IFS= read -r file || [[ -n "$file" ]]; do
  [[ -z "$file" ]] && continue
  # Only root-level source/docs/package files; never secrets or runtime JSON.
  [[ "$file" =~ ^[A-Za-z0-9_-]+\.(js|cjs|md)$ || "$file" == package.json || "$file" == package-lock.json ]] || { echo "Invalid release file: $file" >&2; exit 1; }
  files+=("$file")
  if [[ "$mode" == --check-local ]]; then cp -- "$file" "$stage/$file"; fi
  [[ -f "$stage/$file" && ! -L "$stage/$file" ]] || { echo "Missing or unsafe release file: $file" >&2; exit 1; }
done < "$stage/deploy-files.txt"
for required in bot.js hs-add-pair.cjs match-war-end.cjs package.json package-lock.json; do
  [[ " ${files[*]} " == *" $required "* ]] || { echo "Manifest missing $required" >&2; exit 1; }
done
if [[ "$mode" == --check-local ]]; then cp -R tests "$stage/tests"; fi
[[ -d "$stage/tests" ]] || { echo 'Candidate has no tests.' >&2; exit 1; }
# Keep the running dependency installation intact for reliable file rollback.
cmp -s package-lock.json "$stage/package-lock.json" || { echo 'Dependency lock changed: install and validate dependencies in a separate release before deploying.' >&2; exit 1; }
node - "$root/package.json" "$stage/package.json" <<'JS'
const assert = require('node:assert/strict');
const [current, candidate] = process.argv.slice(2).map(p => require(p));
for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'engines'])
  assert.deepEqual(candidate[key], current[key], `Changed ${key} requires a separate dependency release`);
assert.equal(candidate.scripts?.test, 'node --test tests/*.cjs', 'Missing standard test command');
JS
ln -s "$root/node_modules" "$stage/node_modules"
for file in "${files[@]}"; do
  case "$file" in *.js|*.cjs) node --check "$stage/$file" ;; esac
done
(cd "$stage" && npm test)
if [[ "$mode" == --check-local ]]; then echo 'Local release validation passed; no restart performed.'; exit 0; fi
# Check PM2 exists and the target is registered before modifying production.
pm2 describe fow-elo-bot >/dev/null
mkdir -p "$root/deploy-backups"
backup=$(mktemp -d "$root/deploy-backups/release.XXXXXX")
mkdir -p "$backup/absent"
printf '%s\n' "$revision" > "$backup/candidate-revision.txt"
for file in "${files[@]}"; do
  if [[ -e "$root/$file" ]]; then cp -- "$root/$file" "$backup/$file"; else touch "$backup/absent/$file"; fi
done
changed=1
for file in "${files[@]}"; do cp -- "$stage/$file" "$root/$file"; done
pm2 restart fow-elo-bot
# Require a stable process for 15 seconds, catching immediate restart loops.
expected_pid=$(pm2 pid fow-elo-bot)
[[ "$expected_pid" =~ ^[1-9][0-9]*$ ]]
for attempt in {1..5}; do
  sleep 3
  [[ "$(pm2 pid fow-elo-bot)" == "$expected_pid" ]]
  kill -0 "$expected_pid"
done
changed=0
echo "Deployment $revision completed. Backup: $backup"
