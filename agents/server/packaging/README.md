# sndbox Linux runner

This archive contains the headless sndbox runner for Linux servers and NAS devices. It does not contain the desktop editor.

## Supported hosts

- `linux-x86_64`: 64-bit Intel or AMD Linux (`uname -m` reports `x86_64`)
- `linux-aarch64`: 64-bit ARM Linux (`uname -m` reports `aarch64` or `arm64`)
- systemd-based servers: use the included installer
- container-oriented NAS platforms: use the published `ghcr.io/sndboxhq/sandbox-server-runner` image

## Install on a Linux server

Verify the archive against the release's `SHA256SUMS` and Sigstore bundle before extracting it. From the extracted directory, run:

```sh
sudo ./install.sh
sudo sandbox-runner
```

The installer:

- installs the executable at `/usr/local/bin/sandbox-runner`;
- creates the unprivileged `sandbox-runner` service account;
- creates `/var/lib/sandbox-runner` for persistent identity and state;
- installs `/etc/sandbox-runner/config.toml` without overwriting an existing config;
- installs the hardened `sandbox-runner.service` systemd unit without starting it.

The guided setup replaces the packaged placeholder after validating every answer and preserves the original as `config.toml.bak`. It retains the installed config's `root:sandbox-runner` ownership and `0640` permissions, so the service account can continue to read it after setup or a guarded reconfiguration. The `workspace_id` and `environment_id` must be UUIDs, the control-plane URL must use HTTPS except for localhost development, and every workflow directory or network destination must be explicitly allowed.

Validate the config:

```sh
sudo sandbox-runner setup
sudo -u sandbox-runner /usr/local/bin/sandbox-runner validate
```

Create a runner in the sndbox Operations area and copy its short-lived pairing token. Pair as the service user so the private device identity receives the correct owner and permissions:

```sh
sudo -u sandbox-runner /usr/local/bin/sandbox-runner pair
```

Confirm the printed fingerprint in the Operations area, then start the service:

```sh
sudo systemctl enable --now sandbox-runner
sudo systemctl status sandbox-runner
journalctl -u sandbox-runner -f
```

On a server without systemd, configure its service manager to run `/usr/local/bin/sandbox-runner --config /etc/sandbox-runner/config.toml run` as `sandbox-runner`. Keep `/var/lib/sandbox-runner` persistent.

## NAS and containers

Synology, QNAP, TrueNAS SCALE, and Unraid users should normally use the published container. Mount a completed config read-only at `/etc/sandbox/runner.toml`, persistent storage at `/var/lib/sandbox-runner`, and only explicitly approved workflow directories. The container runs as UID/GID `65532`.

Pair once with the `pair` command and `SANDBOX_PAIRING_TOKEN` supplied only to that container. Then run a long-lived container with the same mounts, the `run` command, a read-only root filesystem, all capabilities dropped, and no-new-privileges enabled. Do not store the pairing token in the config, image, or Compose file.

Complete Linux and NAS instructions are available at <https://docs.sndbox.app/linux>.

## Troubleshooting

- `sudo: sandbox-runner: command not found`: run `sudo ./install.sh` from this extracted archive and use `/usr/local/bin/sandbox-runner`.
- service says the runner is not paired: pair as `sandbox-runner`, not `root`; the identity is stored at `/var/lib/sandbox-runner/identity.json`.
- configuration is invalid: replace all example IDs, URLs, signing keys, and allowlists, then run the validation command above.
- runner stays offline: check `journalctl -u sandbox-runner`, HTTPS reachability, system time, fingerprint confirmation, and whether the runner is paused or draining.
