# Store repository guidance

## Production deployment

- Treat commit, push, and live deployment as separate steps. Deploy only when the user has authorised a live change, and report which steps were completed.
- Before any production deployment, read `/root/thanda-store/runtime/CODEX_ALERTS.md` over SSH. If its status is `WARNING` or `CRITICAL`, investigate before doing non-essential production work.
- Deploy committed changes from the production checkout using `bash deploy/deploy-store.sh --check` followed by `bash deploy/deploy-store.sh`. The command fetches `origin/main`, checks the production Git and PM2 state, prevents overlapping deploys, builds safely, and verifies the login page and CSS. See the deployment section of `README.md` for operational detail.
- Do not replace this path with a manual `git pull`, `npm install`, `npm run build`, or PM2 restart while the Store is serving traffic. Do not enable PM2 file watching or a shell-wrapped Next start command.
- After a deployment or recovery, verify the public site and process status. If the guarded command stops or fails, inspect its output and the preserved build before retrying.

Instructions in `thanda-store/AGENTS.md` also apply when working in the Next.js application.
