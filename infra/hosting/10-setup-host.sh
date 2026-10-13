set -euo pipefail
# Node 24
sudo mkdir -p /opt/node && sudo tar -xJf /tmp/node-v24.21.0-linux-x64.tar.xz -C /opt/node --strip-components=1
/opt/node/bin/node -v
# service account
id agentplat >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/agentplat --create-home --shell /usr/sbin/nologin agentplat
# app
sudo rm -rf /opt/agent-platform.new && sudo mkdir -p /opt/agent-platform.new && sudo tar -xzf /tmp/agentplat-app.tgz -C /opt/agent-platform.new
sudo chown -R root:root /opt/agent-platform.new
[ -d /opt/agent-platform ] && sudo mv /opt/agent-platform /opt/agent-platform.old.$(date +%s) || true
sudo mv /opt/agent-platform.new /opt/agent-platform
# postgres
if ! command -v psql >/dev/null; then sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql >/tmp/pg-install.log 2>&1; fi
sudo systemctl enable --now postgresql
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='agentplat'" | grep -q 1 || sudo -u postgres createuser agentplat
sudo -u postgres psql -tAc "select 1 from pg_database where datname='agentplat'" | grep -q 1 || sudo -u postgres createdb -O agentplat agentplat
sudo -u postgres psql -tAc "show listen_addresses"
# config dir + auth
sudo install -d -m 0750 -o root -g agentplat /etc/agent-platform
sudo install -d -m 0700 -o agentplat -g agentplat /var/lib/agentplat/own /var/lib/agentplat/host-control
sudo -u agentplat env OWN_AUTH_FILE=/var/lib/agentplat/own/auth.json /opt/node/bin/node /opt/agent-platform/runtime/init-auth.mjs
# nomad persistent
sudo install -d -m 0700 /var/lib/nomad
printf 'data_dir = "/var/lib/nomad"\nbind_addr = "127.0.0.1"\nserver {\n  enabled = true\n  bootstrap_expect = 1\n}\nclient {\n  enabled = true\n  servers = ["127.0.0.1"]\n}\n' | sudo tee /etc/nomad.d/server.hcl >/dev/null
ls /etc/nomad.d
