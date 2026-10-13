# Must be refused by the agent: volumes are disabled, so no host-path bind (here the Docker socket).
job "kit-neg-host-socket" {
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
        runtime = "kata"
        mount {
          type   = "bind"
          source = "/var/run/docker.sock"
          target = "/var/run/docker.sock"
        }
        command = "sleep"
        args    = ["300"]
      }
      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
