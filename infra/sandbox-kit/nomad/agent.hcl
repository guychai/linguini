# Nomad agent configuration for the sandbox kit: one dev agent (server + client) on the Linux
# sandbox node (or inside Lima on the Mac path), started by linux/50-nomad.sh as:  nomad agent -dev -bind 127.0.0.1 -config /etc/nomad.d/kit.hcl
# Docker driver options verified against the Nomad 2.0.7 docs
# (developer.hashicorp.com/nomad/docs/deploy/task-driver/docker) and drivers/docker at v2.0.7.
#
# Dev mode keeps server state in memory and has no ACLs. It is for proving the task-driver
# layer only; production needs persistent servers, ACLs and TLS, and the Nomad token must
# never be visible inside a sandbox.

# Loopback only: the backend runs on the same node. (Mac path: Lima forwards it to the Mac.)
bind_addr = "127.0.0.1"

plugin "docker" {
  config {
    endpoint = "unix:///var/run/docker.sock"

    # Only Kata. Nomad's default list is ["runc", "nvidia"]; both are removed so a job that
    # asks for a shared-kernel runtime on this node is refused ("requested runtime ... is not
    # allowed"). Note from drivers/docker/driver.go: a job that sets no runtime at all is not
    # checked against this list and gets Docker's default runtime. 20-install-docker-kata.sh
    # makes that default "kata" on sandbox nodes, the backend refuses to submit a job that does
    # not name runtime "kata" (assertKataJob), and 50-nomad.sh proves the omitted-runtime case.
    allow_runtimes = ["kata"]

    # Stated explicitly so a review sees it. On the Docker path there is no
    # privileged_without_host_devices (containerd-CRI / CRI-O only, Kata privileged.md), so a
    # privileged Kata container would ask the runtime to pass the node's devices into the guest.
    allow_privileged = false

    # Nomad's documented default list, plus exactly the five capabilities the inner dockerd
    # needs inside the Kata guest (see inner/dind-entry.sh and KIT_INNER_CAPS in versions.env).
    # They act on the Kata guest kernel; the VM is the isolation boundary. sys_ptrace is needed
    # for non-root inner containers (dockerd opens their /proc/<pid>/ns/net). Nothing else (no
    # sys_module, sys_rawio).
    allow_caps = [
      "audit_write", "chown", "dac_override", "fowner", "fsetid", "kill", "mknod",
      "net_bind_service", "setfcap", "setgid", "setpcap", "setuid", "sys_chroot",
      "sys_admin", "net_admin", "sys_resource", "net_raw", "sys_ptrace",
    ]

    # No host-path binds and no Docker volumes: a job cannot mount the node's filesystem or the
    # Docker socket. (In v2.0.7, "volume" mounts are refused together with host binds;
    # tmpfs mounts and paths inside the allocation directory stay allowed.)
    volumes {
      enabled = false
    }

    # Upper bound for any job's pids_limit.
    pids_limit = 4096

    extra_labels = ["job_name", "task_group_name", "task_name", "node_name"]

    gc {
      image       = true
      image_delay = "30m"
      container   = true
      dangling_containers {
        enabled = true
      }
    }
  }
}
