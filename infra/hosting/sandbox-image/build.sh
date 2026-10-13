#!/usr/bin/env bash
# Build on the dev host and push to the loopback-only registry (127.0.0.1:5000) so Nomad can
# pin the image by digest. Prints the digest reference for hands.job.json.
set -euo pipefail
TAG=${1:-$(date +%Y-%m-%d)}
cd "$(dirname "$0")"
docker build -t "127.0.0.1:5000/agentplat/sandbox:${TAG}" .
docker push "127.0.0.1:5000/agentplat/sandbox:${TAG}" >/dev/null
docker image inspect --format '{{index .RepoDigests 0}}' "127.0.0.1:5000/agentplat/sandbox:${TAG}"
