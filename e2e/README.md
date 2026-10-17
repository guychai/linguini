# Browser regression suite

Playwright tests (`@playwright/test`, pinned in `package-lock.json`) run against a **live**
deployment. They are not part of CI, since they need a running node and the real model.

```sh
BASE_URL=https://t3-dev.<tailnet>.ts.net \
E2E_CLEANUP_CMD='ssh -i ~/.ssh/<key> <user>@<node> sudo -n -u agentplat psql -d agentplat -q -v ON_ERROR_STOP=1' \
  .linguini/e2e                      # or: cd e2e && npm ci && npx playwright test
.linguini/e2e tests/workspace.spec.ts --project desktop    # any playwright args
```

| Variable | |
| --- | --- |
| `BASE_URL` | Deployment to test (required). |
| `E2E_CLEANUP_CMD` | Command that runs SQL from stdin on the deployment's database; used only to delete this run's throwaway user. Without it, teardown prints the SQL to run by hand. |
| `E2E_CHROMIUM` | Browser binary (default: Playwright's; `npx playwright install chromium`). |
| `E2E_CHROMIUM_ARGS` | Extra Chromium flags, one per line, e.g. `--host-resolver-rules=MAP <host>:443 127.0.0.1:8443` to reach the node through a local tunnel. |
| `E2E_IGNORE_HTTPS_ERRORS=1` | Accept a tunnel's self-signed certificate. |

No secrets live in the repo: the account is created per run and its password is random.

## Accounts and cleanup

- `global-setup.ts` signs up a throwaway account `e2e-<runId>-user@test.linguini` through the
  sign-up screen and saves its session in `.run/` (git-ignored). Every test uses that account.
- `global-teardown.ts` always runs. It deletes the account's conversations through the API (which
  also stops their sandboxes and drops previews and renders), then the user through
  `E2E_CLEANUP_CMD`. The SQL (`cleanup.ts`) only matches that run's own `e2e-<runId>-*` addresses,
  so other users' data is never touched.
- If a run is killed before teardown, remove what it left with
  `cd e2e && E2E_CLEANUP_CMD=... node cleanup.ts <runId>`. The run id is printed at the start
  and kept in `.run/account.json`.

## Coverage

Desktop project (1280×900), then the phone project (390×844, touch). Any uncaught page error fails
the test.

- `auth`: sign in, sign out, sign back in. `/api/admin/*` and `/api/auth/admin/*` return 404 for
  a normal user.
- `settings`: the theme switches to light and back to dark.
- `streaming`: the one long real-model turn (a ten-paragraph essay). Every 2 s, alternately hovering
  and not, it checks: no status chip under user or assistant messages mid-stream or after,
  "Working for …" and the stop button shown while it runs and gone after. A second long prompt is
  then interrupted with the stop button (the job ends `cancelled`, no chip).
- `visual`: an `html_render` reply shows as a card (`/render/` iframe).
- `workspace` (serial, one cheap turn): a short turn completes; the terminal opens and its stream
  carries output; files read and write; a shared preview loads; the finished conversation reloads
  at 1280 without chips.
- `phone`: a turn sent by tapping, no chips, and the empty composer tray stays hidden.

Typing uses `keyboard.type(..., { delay: 40 })`. Machine-speed typing trips React's update-depth
guard (#185) in upstream's composer, which a person can't do.
Screenshots go to `test-results/`, plus a trace for each failure.
Runtime against dev: about 4–5 minutes, mostly model turns.
