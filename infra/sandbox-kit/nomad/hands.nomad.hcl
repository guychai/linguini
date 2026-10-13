# Fixed, reviewed job template for one conversation's hands (handoff section 10).
# The inputs are a server-derived conversation key and a workspace generation, plus the
# conversation's sandbox network (created on the node by egress/node/sandbox-netctl before the
# job is submitted) and the node's egress CA certificate, all validated here (and again by the
# broker: assertKataJob refuses a job whose network is not that conversation's sandbox network). Image, runtime, capabilities, limits and mounts
# are constants: agent or browser input cannot select a different runtime, privilege, mount
# or image. The owned
# runtime's NomadKataHands builds the same job as JSON (src/hands.ts), and a unit test keeps
# the two and inner/dind-entry.sh in step.

variable "conversation_key" {
  type        = string
  description = "Server-derived opaque key for (principal, conversation); never user text."
  validation {
    # Nomad's HCL2 has no regex(); regex_replace leaves "" only on a full match. (A can(regex())
    # check here silently evaluates false: can() swallows the unknown-function error.)
    condition     = regex_replace(var.conversation_key, "^[a-z0-9]{12,40}$", "") == ""
    error_message = "The conversation_key must be 12-40 lowercase hex/alphanumeric characters."
  }
}

variable "generation" {
  type        = number
  description = "Workspace generation; replacing compute increments it."
  validation {
    condition     = var.generation >= 1 && var.generation == floor(var.generation)
    error_message = "The generation must be a positive integer."
  }
}

# The conversation's own Docker bridge network ("sbx" + the first 12 key characters), forced
# through the egress proxy by the node's nftables (egress/node/sandbox-net.sh): no route out, DNS
# redirected to the proxy, metadata/link-local unreachable, IPv6 dropped, source IP bound to the
# bridge. Task-level network_mode (not a group "bridge"/"cni" network): those make Nomad create a
# pause container and join the task to it with network_mode "container:<id>", which Kata under
# Docker cannot share, and they need CNI plugins plus Nomad-managed iptables.
variable "sandbox_network" {
  type = string
  validation {
    condition     = regex_replace(var.sandbox_network, "^sbx[a-z0-9]{1,12}$", "") == ""
    error_message = "The sandbox_network must be a per-sandbox network name sbx[a-z0-9]{1,12}."
  }
}

variable "sandbox_ipv4" {
  type        = string
  description = "The sandbox's fixed address on its network (bound to it in nftables)."
  validation {
    condition     = regex_replace(var.sandbox_ipv4, "^10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$", "") == ""
    error_message = "The sandbox_ipv4 must be a 10.x.y.z address."
  }
}

variable "sandbox_gateway" {
  type        = string
  description = "The node side of the sandbox network: transparent egress proxy (TCP 80/443 redirected) and DNS (:53, redirected)."
  validation {
    condition     = regex_replace(var.sandbox_gateway, "^10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$", "") == ""
    error_message = "The sandbox_gateway must be a 10.x.y.z address."
  }
}

variable "egress_ca_pem" {
  type        = string
  description = "The node egress CA certificate (public; its key never leaves the node)."
  validation {
    condition     = regex_replace(var.egress_ca_pem, "(?s)^-----BEGIN CERTIFICATE-----\\n[A-Za-z0-9+/=\\n]+-----END CERTIFICATE-----\\n?$", "") == ""
    error_message = "The egress_ca_pem must be exactly one PEM certificate."
  }
}

# HCL block labels cannot be interpolated, so the label is a placeholder: the broker (and
# 50-nomad.sh) parses this file through /v1/jobs/parse and registers the JSON with
# ID = "hands-<conversation_key>-g<generation>" and EnforceIndex/JobModifyIndex 0 (create
# only). That deterministic ID is what makes allocation idempotent per conversation+generation.
job "hands" {
  type        = "service"
  datacenters = ["*"]

  meta {
    template         = "hands-kata-dind/v1"
    conversation_key = var.conversation_key
    generation       = var.generation
  }

  group "hands" {
    count = 1

    # A crashed sandbox VM is restarted in place twice, then the allocation fails and stays
    # failed: the broker sees a real failure and decides; Nomad never silently places it
    # elsewhere with a fresh workspace.
    restart {
      attempts = 2
      interval = "10m"
      delay    = "5s"
      mode     = "fail"
    }
    reschedule {
      attempts  = 0
      unlimited = false
    }

    task "hands" {
      driver       = "docker"
      kill_timeout = "30s"

      config {
        # Built from infra/hosting/sandbox-image: pinned docker:dind base + CLI tools + mise
        # (Node LTS, Python). Served by the loopback-only registry on the node.
        image   = "127.0.0.1:5000/agentplat/sandbox@sha256:147accb19f358eb1c2ebe5a59fd943158a680ca25fa4f5ded40d8fbd23b2afaa"
        runtime = "kata"

        # The conversation's sandbox network only (see variable "sandbox_network").
        network_mode = var.sandbox_network
        ipv4_address = var.sandbox_ipv4
        dns_servers  = [var.sandbox_gateway]

        # Capabilities for the inner dockerd, acting on the Kata guest kernel only. Not
        # privileged; see inner/dind-entry.sh and nomad/agent.hcl.
        cap_add = ["sys_admin", "net_admin", "sys_resource", "net_raw", "sys_ptrace"]

        # /proc/sys is read-only in a non-privileged container, and the inner dockerd refuses to
        # start unless IPv4 forwarding is on (it skips the write when it already is). Namespaced
        # sysctl, applied by the Kata agent in the guest kernel; found on the dev VM (Ubuntu 26.04).
        sysctl = {
          "net.ipv4.ip_forward" = "1"
        }

        pids_limit = 4096
        # Hard CPU quota so Kata can size the guest's vCPUs from it (soft shares give it no
        # number to size from).
        cpu_hard_limit = true

        # Inner Docker storage: guest-local tmpfs (Kata's documented DinD workaround; virtio-fs
        # cannot be an overlayfs upper layer). 40-inner-docker.sh probes this before relying on it.
        mount {
          type   = "tmpfs"
          target = "/var/lib/docker"
          tmpfs_options {
            size = 4294967296
          }
        }

        entrypoint = ["sh"]
        args = ["-c", <<EOT
# Entrypoint for the inner Docker daemon inside a Kata guest. Passed as `sh -c` to the pinned
# docker:dind image by 40-inner-docker.sh and by the Nomad job template; the owned runtime's
# NomadKataHands embeds the same text (a unit test keeps them identical).
#
# Why not --privileged: with Docker as the outer engine there is no
# privileged_without_host_devices switch (that is containerd-CRI / CRI-O only, per Kata's
# privileged.md), so a privileged Kata container asks the runtime to pass the Lima VM's host
# devices into the guest. The container instead gets a few capabilities; they act on the Kata
# guest kernel, whose boundary is the VM, not on the Lima kernel.
#
# Kata mounts cgroup2 read-only for a non-privileged container (as runc does). The dind script
# must create /sys/fs/cgroup/init and enable controllers, so remount it read-write
# (CAP_SYS_ADMIN, guest kernel only). Fail fast instead of letting dind's loop spin forever.
set -eu
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
# /proc/sys is read-only too; dockerd writes per-interface sysctls (IPv6 on each container veth,
# IPv4 forwarding) and fails "docker run" without them. Guest kernel only, like the cgroup remount.
mount -o remount,rw /proc/sys 2>/dev/null || true
if ! mkdir -p /sys/fs/cgroup/init 2>/dev/null; then
  echo "kit: /sys/fs/cgroup is not writable; inner dockerd cannot manage cgroups" >&2
  exit 70
fi
# Docker gives containers on a user-defined network its embedded resolver (127.0.0.11), which
# lives in the host's network namespace and is unreachable from inside a Kata guest, so every
# plain lookup failed. Point the guest at the gateway instead; nftables sends any DNS there to the
# egress proxy, which answers only allowlisted names. Inner containers inherit this file.
# (No brace expansions here: Nomad interpolates them in task config.)
dns=$(printenv SANDBOX_DNS || true)
if [ -n "$dns" ] && grep -q '^nameserver 127\.0\.0\.11' /etc/resolv.conf 2>/dev/null; then
  printf 'nameserver %s\noptions ndots:0\n' "$dns" > /etc/resolv.conf ||
    echo "kit: could not rewrite /etc/resolv.conf" >&2
fi
# Trust the node's egress CA system-wide. The egress proxy is transparent (nftables redirects
# TCP 80/443 to it), so the guest has no proxy settings, only this trust. The job's CA env vars
# point at the system bundle; dockerd (Go) reads it at start, so install before exec.
if [ -s /local/egress-ca.pem ]; then
  mkdir -p /usr/local/share/ca-certificates
  cp /local/egress-ca.pem /usr/local/share/ca-certificates/linguini-egress-ca.crt
  update-ca-certificates >/dev/null 2>&1 || cat /local/egress-ca.pem >> /etc/ssl/certs/ca-certificates.crt
fi
# The workspace is the only persistent path. /var/lib/docker is whatever the caller mounted.
mkdir -p /workspace
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock
EOT
        ]
      }

      env {
        DOCKER_TLS_CERTDIR = ""
        # Resolver for /etc/resolv.conf (see the entry script): the gateway, i.e. the proxy DNS.
        SANDBOX_DNS = var.sandbox_gateway
        # No proxy settings: the egress proxy is transparent (nftables redirects TCP 80/443 to it).
        # CA trust only. This exact set is the one Vercel Sandbox sets so common tools and runtimes
        # use the system bundle, where the entry script installs the node CA:
        # https://vercel.com/docs/sandbox/concepts#proxy-ca-certificates
        AWS_CA_BUNDLE                    = "/etc/ssl/certs/ca-certificates.crt"
        CARGO_HTTP_CAINFO                = "/etc/ssl/certs/ca-certificates.crt"
        CURL_CA_BUNDLE                   = "/etc/ssl/certs/ca-certificates.crt"
        GIT_SSL_CAINFO                   = "/etc/ssl/certs/ca-certificates.crt"
        GRPC_DEFAULT_SSL_ROOTS_FILE_PATH = "/etc/ssl/certs/ca-certificates.crt"
        NODE_EXTRA_CA_CERTS              = "/etc/ssl/certs/ca-certificates.crt"
        NODE_USE_SYSTEM_CA               = "1"
        NPM_CONFIG_CAFILE                = "/etc/ssl/certs/ca-certificates.crt"
        PIP_CERT                         = "/etc/ssl/certs/ca-certificates.crt"
        REQUESTS_CA_BUNDLE               = "/etc/ssl/certs/ca-certificates.crt"
        SSL_CERT_FILE                    = "/etc/ssl/certs/ca-certificates.crt"
      }

      # The CA certificate as a task-local file (the agent disables host volumes; the task's
      # local/ directory is always mounted). Data only: no lookups in it.
      template {
        data        = var.egress_ca_pem
        destination = "local/egress-ca.pem"
        perms       = "0644"
        change_mode = "noop"
      }

      resources {
        cpu    = 4000
        memory = 8192
      }
    }
  }
}
