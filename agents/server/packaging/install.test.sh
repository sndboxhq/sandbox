#!/usr/bin/env sh
set -eu

packaging_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT HUP INT TERM

package_directory="$temporary_directory/package"
install_root="$temporary_directory/root"
mkdir -p "$package_directory"
cp -- "$packaging_directory/install.sh" "$package_directory/install.sh"
cp -- "$packaging_directory/sandbox-runner.service" "$package_directory/sandbox-runner.service"
cp -- "$packaging_directory/../config.example.toml" "$package_directory/config.example.toml"
printf '#!/usr/bin/env sh\nprintf "sandbox-runner test binary\\n"\n' > "$package_directory/sandbox-runner"
chmod 0755 "$package_directory/install.sh" "$package_directory/sandbox-runner"

DESTDIR="$install_root" "$package_directory/install.sh"

test -x "$install_root/usr/local/bin/sandbox-runner"
test -f "$install_root/etc/sandbox-runner/config.toml"
test -d "$install_root/var/lib/sandbox-runner/plugins"
test -f "$install_root/etc/systemd/system/sandbox-runner.service"
test "$(stat -c '%a' "$install_root/usr/local/bin/sandbox-runner")" = '755'
test "$(stat -c '%a' "$install_root/etc/sandbox-runner")" = '750'
test "$(stat -c '%a' "$install_root/etc/sandbox-runner/config.toml")" = '640'
test "$(stat -c '%a' "$install_root/var/lib/sandbox-runner")" = '700'
test "$(stat -c '%a' "$install_root/var/lib/sandbox-runner/plugins")" = '700'
test "$(stat -c '%a' "$install_root/etc/systemd/system/sandbox-runner.service")" = '644'
grep -q '^ExecStart=/usr/local/bin/sandbox-runner' \
  "$install_root/etc/systemd/system/sandbox-runner.service"

printf '\n# preserved-on-upgrade\n' >> "$install_root/etc/sandbox-runner/config.toml"
DESTDIR="$install_root" "$package_directory/install.sh"
grep -q '^# preserved-on-upgrade$' "$install_root/etc/sandbox-runner/config.toml"

printf 'Linux runner installer test passed.\n'
