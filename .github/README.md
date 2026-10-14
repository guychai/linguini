# Linguini

> **Unofficial.** Linguini is built on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., used under the MIT License. It is not affiliated with, endorsed by, or supported by T3 Tools.

Linguini turns T3 Code into a multi-user agent platform: per-conversation Kata sandboxes on Nomad, a mitmproxy egress allowlist, S3 workspace persistence, preview ports, visual replies, and Better Auth accounts on Postgres.

**This repo holds only Linguini's code.** Upstream T3 Code is pinned (`.linguini/upstream.pin`), changed by per-file patches (`.linguini/patches/`), and partly dropped (`.linguini/deleted`). To get a full tree:

```sh
.linguini/assemble && cd .linguini/build && pnpm install
```

Workflow (edit, regen, bump, guard): [.linguini/README.md](../.linguini/README.md). Platform docs: [PROTOTYPES.md](../PROTOTYPES.md), [infra/hosting/README.md](../infra/hosting/README.md), [UPSTREAM](../UPSTREAM).
