# Patch layout

This repo holds only Linguini's own code. Upstream T3 Code is not in the repo. It is pinned and
patched:

- `.linguini/upstream.pin`: upstream repo, the release tag we track (`tag=`, absent for a branch/commit pin) and its commit. We pin to stable upstream releases.
- `.linguini/patches/<path with / as __>.patch`: one patch per upstream file we change
  (`git diff --full-index --binary`).
- `.linguini/deleted`: upstream files we don't carry. It's a list, not patches, so upstream edits
  to them never conflict.
- Everything else in the repo (prototypes/, apps/owned-web/, infra/hosting, infra/sandbox-kit,
  our files inside apps/web/src, .github/workflows/linguini-ci.yml, .github/README.md,
  PROTOTYPES.md, UPSTREAM) is ours and is copied over the patched tree at the same path. The
  repo's own `.gitignore` is not copied; the assembled tree gets upstream's `.gitignore` plus its
  patch.

## Workflow

```sh
.linguini/assemble            # -> .linguini/build: upstream@pin + patches + deletions + our files
cd .linguini/build && pnpm install && pnpm run typecheck   # build, test and edit here
.linguini/regen               # write edits back: upstream files -> patches/deleted, ours -> repo
git add -A && git commit      # in this repo
.linguini/status              # 0 in sync, 1 unsaved edits in the build tree, 2 build tree is stale
.linguini/bump [REF]          # try the patches on upstream REF (tag, branch or commit; default: latest stable vX.Y.Z tag)
.linguini/bump [REF] --write  # ... and move the pin (recording tag= for a tag), regenerating patches against it
```

- **Don't lose work:** edits in `.linguini/build` live only there until you run `regen`, and
  `assemble` wipes and rebuilds that directory (including node_modules). `.linguini/status`
  reports unsaved edits. Opt into a pre-commit warning with
  `git config core.hooksPath .linguini/hooks`; add `LINGUINI_STRICT=1` to make it block the
  commit. `regen` refuses a build tree assembled before the repo last changed, because it would
  undo those changes; re-assemble, or use `FORCE=1` if you really mean it.
- **CI** assembles the tree, then checks that `regen` on the untouched tree reproduces the
  patches byte for byte (a hand-edited or stale patch fails). It then runs typecheck, test and
  build inside `.linguini/build`.
- `assemble` fetches the pinned commit shallowly into a cache
  (`~/.cache/linguini-upstream.git`, or `LINGUINI_UPSTREAM_CACHE`). It applies each patch with
  `git apply --index`, falling back to `--3way`. The build tree is a git repo: tag `upstream` is
  the pin, followed by the commits "linguini patches" and "linguini overlay" (tag `assembled`),
  so `git diff upstream` inside it is our whole delta. Commits use fixed dates, so the same
  inputs give the same commit ids.
- `bump` reports `clean`, `3way` (merged, so review it) or `FAILED` (fix it in the printed tree,
  then `regen <tree>`). If `pnpm-lock.yaml.patch` fails, or with `RELOCK=1`, it takes upstream's
  lock and runs `pnpm install --lockfile-only`. After a bump, check for new upstream automation
  (e.g. `.github/workflows`, `.github/scripts`) and add it to `deleted` (see UPSTREAM).
  `pnpm-workspace.yaml` is unpatched (upstream's `apps/*` already includes apps/owned-web).
  prototypes/runtime is npm with its own lock, so it's ours as-is.
- **Browser regression suite:** `.linguini/e2e` runs `e2e/` (Playwright) against a live deployment; see e2e/README.md.
- **Deploy:** `infra/hosting/deploy-dev.sh` (see infra/hosting/README.md) assembles in a temp dir
  and records our commit plus the upstream pin in the node's `DEPLOYED_COMMIT`.
- Keep patches small: put logic in our own files (e.g. `apps/web/src/uiFlags.ts`,
  `apps/web/src/components/chat/linguiniComposer.tsx`) and leave only hook points in upstream
  files.
