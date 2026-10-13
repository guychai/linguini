#!/usr/bin/env bash
# Sandbox persistence storage on the dev VM: SeaweedFS in Docker (named volume), loopback S3.
# Idempotent. Generates S3 keys once into /etc/agent-platform/secrets.env (root 0600) and the
# matching SeaweedFS identity file (root 0600); never prints them.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=${SEAWEEDFS_IMAGE:?pin by digest, e.g. chrislusf/seaweedfs@sha256:...}
sec=/etc/agent-platform/secrets.env
sudo install -d -m 0755 /opt/agent-platform/infra/hosting/seaweedfs
sudo cp "$here/seaweedfs/compose.yml" /opt/agent-platform/infra/hosting/seaweedfs/compose.yml
if ! sudo grep -q '^S3_ACCESS_KEY_ID=' "$sec"; then
  id=lg$(openssl rand -hex 10); key=$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-40)
  printf 'S3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\n' "$id" "$key" | sudo tee -a "$sec" >/dev/null
fi
sudo chmod 0600 "$sec"
sudo sh -c ". $sec; umask 077; cat > /etc/agent-platform/seaweedfs-s3.json <<J
{\"identities\":[{\"name\":\"linguini\",\"credentials\":[{\"accessKey\":\"\$S3_ACCESS_KEY_ID\",\"secretKey\":\"\$S3_SECRET_ACCESS_KEY\"}],\"actions\":[\"Read\",\"Write\",\"List\",\"Tagging\",\"Admin\"]}]}
J"
# The image drops to user seaweed (uid 1000) via su-exec; only it (and root) may read the keys.
sudo chown 1000:1000 /etc/agent-platform/seaweedfs-s3.json
sudo chmod 0400 /etc/agent-platform/seaweedfs-s3.json
printf 'SEAWEEDFS_IMAGE=%s\nS3_CONFIG=/etc/agent-platform/seaweedfs-s3.json\n' "$image" | sudo tee /etc/agent-platform/seaweedfs.env >/dev/null
sudo cp "$here/seaweedfs/linguini-s3.service" /etc/systemd/system/linguini-s3.service
sudo systemctl daemon-reload
sudo systemctl enable --now linguini-s3.service
