# Records a known gap: with no runtime set, Nomad 2.0.7 does not consult allow_runtimes and Docker
# uses its default runtime (runc). The reviewed template always sets runtime = "kata"; closing the
# gap for any job needs Docker's default-runtime on hands nodes or a Nomad policy check.
job "kit-neg-no-runtime" {
  datacenters = ["*"]
  group "g" {
    restart {
      attempts = 0
      mode     = "fail"
    }
    reschedule {
      attempts  = 0
      unlimited = false
    }
    task "t" {
      driver = "docker"
      config {
        image   = "docker.io/library/busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
        command = "sleep"
        args    = ["300"]
        # As in hands.nomad.hcl. Without it Nomad pins the container to every node CPU
        # (cpuset 0-N), and Kata runtime-rs 3.x on the dev node then never reaches its agent
        # (vsock ENODEV), so the job would fail before showing which runtime it got.
        cpu_hard_limit = true
      }
      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
