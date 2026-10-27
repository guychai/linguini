# Sandbox image

`agentplat/sandbox:<date>` is the pinned `docker:29.8.2-dind` plus everyday tools. The inner dockerd and the job template's entrypoint are unchanged.

- apk packages: bash (root's login shell; used by the bash tool and the user terminal), curl, wget, git, ca-certificates, GNU coreutils/findutils/grep/sed/gawk, procps, iproute2, bind-tools, jq, less, vim, nano, openssh-client, tar/gzip/xz/unzip, make, tzdata. Also libstdc++/libgcc for the musl Node builds.
- [mise](https://mise.jdx.dev): a pinned release with its SHA-256 checked. `/etc/mise/config.toml` preinstalls Node LTS and Python 3.13, using precompiled musl builds (`node.flavor=musl` from unofficial-builds.nodejs.org; python-build-standalone). Shims in `/opt/mise/shims` come first on PATH, both in the image ENV and via `/etc/profile.d/00-mise.sh` for login shells. `mise use node@22` and similar install other versions on demand through the egress allowlist. The hosts are in `../egress-default-rules.json`: mise-versions.jdx.dev, unofficial-builds.nodejs.org, github.com + release-assets.githubusercontent.com, pypi; all GET/HEAD.
- The proxy variables and the egress CA still come from the Nomad job env (unchanged).
- Git: system config rewrites `git@github.com:`, `ssh://git@github.com/` and `git://github.com/` to `https://github.com/` (no SSH route out of a sandbox), and `GIT_TERMINAL_PROMPT=0` makes a refused clone fail at once instead of waiting for a password. The egress proxy adds GitHub App credentials for private repositories; the sandbox never has any (see `../../sandbox-kit/egress/GITHUB.md`).

Build on the node (never inside a sandbox). The image is pushed to a loopback-only registry, so the job can pin it by digest:

```
docker run -d --restart=always -p 127.0.0.1:5000:5000 -v /var/lib/agentplat-registry:/var/lib/registry \
  --name agentplat-registry docker.io/library/registry:3     # once
sudo ./build.sh 2026-10-12      # prints 127.0.0.1:5000/agentplat/sandbox@sha256:…
```

Then put that reference into `infra/sandbox-kit/nomad/hands.job.json` and `hands.nomad.hcl`. The 2026-10-12 build is 1.19 GB uncompressed (base 510 MB; mise ≈145 MB, Node ≈190 MB, Python ≈100 MB, apk ≈250 MB).

Seen in the egress audit log during on-demand installs, all harmless and left denied: POST mise-versions.jdx.dev (usage tracking), downloads.python.org and tuf-repo-cdn.sigstore.dev (optional signature checks).
