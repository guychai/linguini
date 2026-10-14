# Patch layout (prototype)

This branch holds only Linguini's own code. Upstream T3 Code is not in the repo. It is pinned and
patched:

- `.linguini/upstream.pin`: upstream repo and commit.
- `.linguini/patches/<path with / as __>.patch`: one patch per upstream file we change
  (`git diff --full-index --binary`).
- `.linguini/deleted`: upstream files we don't carry. It's a list, not patches, so upstream edits
  to them never conflict.
- Everything else in the repo (prototypes/, apps/owned-web/, infra/hosting, infra/sandbox-kit,
  our files inside apps/web/src, .github/workflows/linguini-ci.yml, PROTOTYPES.md, UPSTREAM) is
  ours and is copied over the patched tree at the same path. The repo's own `.gitignore` is not
  copied; the assembled tree gets upstream's `.gitignore` plus its patch.

## Workflow

```sh
.linguini/assemble            # -> .linguini/build: upstream@pin + patches + deletions + our files
cd .linguini/build && pnpm install && pnpm run typecheck   # work, build, test here
# edit anything in .linguini/build (upstream files or ours), then write the edits back:
.linguini/regen               # upstream files -> patches/deleted, our files -> repo paths
git add -A && git commit      # in this repo
.linguini/bump [REF]          # try the patches on upstream REF (default main); report per patch
.linguini/bump REF --write    # ... and move the pin, regenerating patches against it
```

- `assemble` fetches the pinned commit shallowly into a cache
  (`~/.cache/linguini-upstream.git`, or `LINGUINI_UPSTREAM_CACHE`). It applies each patch with
  `git apply --index`, falling back to `--3way`. The build tree is a git repo with tag `upstream`
  (the pin), then the commits "linguini patches" and "linguini overlay", so `git diff upstream`
  inside it is our whole delta. Commits use fixed dates, so the same inputs give the same commit
  ids.
- `regen` is deterministic: regenerating from an untouched assembled tree changes nothing (CI
  checks this).
- `bump` reports `clean`, `3way` (merged, so review it) or `FAILED` (fix it in the printed tree,
  then `regen`). If `pnpm-lock.yaml.patch` fails, or with `RELOCK=1`, it takes upstream's lock
  and runs `pnpm install --lockfile-only`. `pnpm-workspace.yaml` is unpatched (upstream's
  `apps/*` already includes apps/owned-web). prototypes/runtime is npm with its own lock, so it's
  ours as-is.
- Keep patches small: put logic in our own files (e.g. `apps/web/src/uiFlags.ts`,
  `apps/web/src/components/chat/linguiniComposer.tsx`) and leave only hook points in upstream
  files.
