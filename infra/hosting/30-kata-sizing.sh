# Kata guest = default_memory (base) + container memory limit (static_sandbox_resource_mgmt=true).
# Lower the base from 2048 to 512 MiB so a 2 GiB sandbox is a ~2.5 GiB guest. Original kept as .orig.
set -euo pipefail
K=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml
[ -f $K.orig ] || sudo cp -p $K $K.orig
sudo sed -i 's/^default_memory = 2048$/default_memory = 512/' $K
grep -n '^default_memory' $K
