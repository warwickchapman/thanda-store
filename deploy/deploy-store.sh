#!/usr/bin/env bash
# Deploy the committed Store application on the VPS. Run as root from any directory.
set -Eeuo pipefail

repo="${THANDA_STORE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
app="$repo/thanda-store"
build_backup="$app/.next.predeploy"
modules_backup="$app/node_modules.predeploy"
alert_file="$repo/runtime/CODEX_ALERTS.md"
check_only=false
if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_only=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

if [[ "$repo" != /root/thanda-store ]]; then
  echo "This command must run from the production checkout at /root/thanda-store." >&2
  exit 1
fi

exec 9>/run/lock/thanda-store-deploy.lock
if ! flock -n 9; then
  echo "Another Store deployment is running." >&2
  exit 1
fi

if [[ ! -f "$alert_file" ]] || ! grep -q '^Status: \*\*OK\*\*' "$alert_file"; then
  echo "Production health is not OK. Review $alert_file before deploying." >&2
  exit 1
fi

if ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
  echo "Tracked production files have local changes. Preserve or resolve them before deploying." >&2
  git -C "$repo" status --short -uno >&2
  exit 1
fi
if [[ -n "$(git -C "$repo" ls-files --others --exclude-standard -- thanda-store/src)" ]]; then
  echo "Untracked application source files exist in production. Review them before deploying." >&2
  exit 1
fi

if [[ -e "$build_backup" || -e "$modules_backup" ]]; then
  echo "A previous deployment backup remains. Review it before deploying." >&2
  exit 1
fi

# Check the process without printing its environment or credentials.
if ! pm2 jlist | node -e '
  let json = "";
  process.stdin.on("data", chunk => json += chunk).on("end", () => {
    const apps = JSON.parse(json).filter(app => app.name === "thanda-store");
    const env = apps[0]?.pm2_env;
    const expected = "/root/thanda-store/thanda-store/node_modules/next/dist/bin/next";
    if (apps.length !== 1 || env?.pm_exec_path !== expected || env?.pm_cwd !== "/root/thanda-store/thanda-store" || env?.watch !== false) {
      console.error("PM2 must run Next directly from the Store directory with file watching disabled.");
      process.exitCode = 1;
    }
  });
'; then
  exit 1
fi

git -C "$repo" fetch --quiet origin main
current="$(git -C "$repo" rev-parse HEAD)"
target="$(git -C "$repo" rev-parse origin/main)"
if ! git -C "$repo" merge-base --is-ancestor "$current" "$target"; then
  echo "Production commit diverges from origin/main. Reconcile it before deploying." >&2
  exit 1
fi

if [[ "$check_only" == true ]]; then
  echo "Deployment checks passed. Current: ${current:0:7}; target: ${target:0:7}."
  exit 0
fi
if [[ "$current" == "$target" ]]; then
  echo "Store is already at ${target:0:7}; no deployment needed."
  exit 0
fi

lock_changed=false
if ! git -C "$repo" diff --quiet "$current" "$target" -- thanda-store/package-lock.json; then
  lock_changed=true
fi

rollback() {
  local failed_status=$?
  trap - ERR
  set +e
  echo "Deployment failed; restoring the previous build and commit." >&2
  pm2 stop thanda-store >/dev/null 2>&1
  git -C "$repo" switch --detach --quiet "$current"
  if [[ -d "$build_backup" ]]; then
    if [[ -d "$app/.next" ]]; then mv "$app/.next" "$app/.next.failed.$(date +%s)"; fi
    mv "$build_backup" "$app/.next"
  fi
  if [[ -d "$modules_backup" ]]; then
    if [[ -d "$app/node_modules" ]]; then mv "$app/node_modules" "$app/node_modules.failed.$(date +%s)"; fi
    mv "$modules_backup" "$app/node_modules"
  fi
  pm2 restart thanda-store >/dev/null 2>&1
  pm2 save >/dev/null 2>&1
  echo "Previous Store restart attempted. Check PM2 and the site before another deploy." >&2
  exit "$failed_status"
}
trap rollback ERR

# Next removes/replaces .next during a build. Stop serving it first so visitors
# never receive HTML whose CSS or JS has already disappeared.
pm2 stop thanda-store
if [[ -d "$app/.next" ]]; then mv "$app/.next" "$build_backup"; fi
if [[ "$lock_changed" == true && -d "$app/node_modules" ]]; then
  mv "$app/node_modules" "$modules_backup"
fi
git -C "$repo" switch --detach --quiet "$target"
if [[ "$lock_changed" == true ]]; then
  (cd "$app" && npm ci --no-audit --no-fund)
fi
(cd "$app" && npm run build)
test -s "$app/.next/BUILD_ID"
pm2 restart thanda-store

ready=false
for attempt in {1..20}; do
  if html="$(curl -fsS --max-time 3 http://127.0.0.1:3000/login 2>/dev/null)"; then
    css_path="$(printf '%s' "$html" | grep -oE '/_next/static/[^" ]+\.css' | head -1 || true)"
    if [[ -n "$css_path" ]] && curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:3000$css_path"; then
      ready=true
      break
    fi
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "The new Store did not serve its login page and CSS." >&2
  false
fi

pm2 save
trap - ERR
if [[ -d "$build_backup" ]]; then rm -rf -- "$build_backup"; fi
if [[ -d "$modules_backup" ]]; then rm -rf -- "$modules_backup"; fi
echo "Deployed ${target:0:7}; login page and CSS are healthy."
