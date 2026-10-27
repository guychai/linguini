# Sandbox image for conversation sandboxes (Kata microVM, Nomad task "hands").
# Built on the host (dev), never inside a sandbox; the base stays the pinned docker:dind so the
# inner dockerd keeps working with the job template's entrypoint.
FROM docker.io/library/docker:29.8.2-dind@sha256:1e08cdb63405ca788aea94ef35b792d1e299607c667d33d7bcbcae1fd2611ced

# Everyday CLI tools. Language runtimes come from mise (below), not apk; libstdc++/libgcc are
# what the musl Node builds link against.
RUN apk add --no-cache \
      bash bash-completion curl wget git ca-certificates coreutils findutils grep sed gawk \
      procps iproute2 bind-tools jq less vim nano openssh-client \
      tar gzip xz unzip make tzdata libstdc++ libgcc \
 && sed -i 's#^root:\(.*\):/bin/[a-z]*$#root:\1:/bin/bash#' /etc/passwd

# Git over HTTPS only (the sandbox has no route to port 22): GitHub SSH remotes are rewritten to
# HTTPS, where the egress proxy adds GitHub App credentials for private repositories
# (infra/sandbox-kit/egress/addon/github_app.py). No credential helper and no password prompts:
# the sandbox never holds GitHub credentials, so a prompt could only hang.
RUN git config --system url."https://github.com/".insteadOf "git@github.com:" \
 && git config --system --add url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --system --add url."https://github.com/".insteadOf "git://github.com/"
ENV GIT_TERMINAL_PROMPT=0

# mise: pinned release, checksum-verified (musl build for Alpine).
ARG MISE_VERSION=v2026.10.8
ARG MISE_SHA256=043dc6b9077db988269ca2f85059851cb09fc080355350021363e95a5e227f84
RUN curl -fsSL -o /usr/local/bin/mise \
      "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64-musl" \
 && echo "${MISE_SHA256}  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/mise

ENV MISE_DATA_DIR=/opt/mise \
    MISE_CACHE_DIR=/var/cache/mise \
    MISE_YES=1 \
    PATH=/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY mise-config.toml /etc/mise/config.toml
COPY profile-mise.sh /etc/profile.d/00-mise.sh

# Preinstalled defaults (global config): current Node LTS and Python. Other versions install on
# demand (`mise use node@22`) through the egress allowlist.
RUN mise install && mise reshim && node --version && python --version \
 && rm -rf /var/cache/mise /root/.cache
