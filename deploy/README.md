# VPS deployment

Runs CloudCLI on a dedicated VPS, reachable **only over Tailscale**. Nothing
listens on a public interface: the container is bound to loopback and Tailscale
Serve terminates HTTPS on the tailnet.

Everything on the host is created by the `Deploy VPS` workflow. There is no
manual step on the machine itself — provisioning, configuration, secrets and
the admin account are all applied by replayable scripts.

## Layout

| File | Responsibility |
|---|---|
| `../Dockerfile` | Builds the app image (native addons compiled in a builder stage, runtime runs unprivileged) |
| `compose.yml` | The deployed composition: image, loopback binding, volumes, log rotation |
| `scripts/bootstrap.sh` | **Host** state: packages, Docker, Tailscale, firewall, directory layout |
| `scripts/deploy.sh` | **Application** state: runtime config, image, container, admin account, tailnet route |
| `scripts/seed-admin.cjs` | Claims the single account before anyone else can |
| `scripts/lib/common.sh` | Output helpers and guards shared by both scripts |

The split is deliberate: `bootstrap.sh` knows nothing about CloudCLI, and
`deploy.sh` never provisions the machine. Each one inspects the current state
before acting, so both can be replayed at will.

## Prerequisites

1. **A dedicated VPS** (Debian or Ubuntu), reachable over SSH with a key. Give
   it nothing else to run — this box hands a shell to an agent.
2. **A Tailscale tailnet** with **MagicDNS** and **HTTPS certificates** enabled
   (Admin console → DNS). `tailscale serve` cannot issue a certificate without
   them, and the deploy stops with that exact message if they are missing.
3. **A reusable Tailscale auth key** (Admin console → Settings → Keys).

## Secrets

Repository → Settings → Secrets and variables → Actions.

### Required secrets

| Name | Purpose |
|---|---|
| `VPS_HOST` | Hostname or IP used for SSH |
| `VPS_SSH_PRIVATE_KEY` | Private key authorized on the VPS |
| `TAILSCALE_AUTHKEY` | Enrolls the host on the tailnet (first run only) |
| `CLOUDCLI_ADMIN_USERNAME` | Claims the account on first deploy |
| `CLOUDCLI_ADMIN_PASSWORD` | At least 6 characters |

### Optional secrets

| Name | Effect when set |
|---|---|
| `VPS_SSH_KNOWN_HOSTS` | Pins the server's host key. Without it the workflow trusts whatever answers and emits a warning — set it once you know the fingerprint (`ssh-keyscan <host>`). |
| `CLOUDCLI_JWT_SECRET` | Fixes the session signing secret. Left unset, one is generated on first deploy and reused from then on. |
| `ANTHROPIC_API_KEY` | Authenticates Claude Code without an interactive login. |
| `OPENAI_API_KEY` | Same, for the Codex provider. |

### Optional variables

| Name | Default |
|---|---|
| `VPS_SSH_USER` | `root` |
| `TAILSCALE_HOSTNAME` | `cloudcli` |

No registry credentials are needed: the workflow's own `GITHUB_TOKEN` authorizes
the pull, and the host is logged out again when the deploy ends.

## Deploying

Actions → **Deploy VPS** → Run workflow.

`Run host provisioning` is on by default and costs a few seconds once the host
is set up; leave it on unless you have a reason not to.

The workflow builds the image, pushes it to GHCR, uploads the scripts, brings
the host to the desired state, rolls the container out, waits for the
healthcheck, claims the admin account if it is still unclaimed, and publishes
the tailnet route. The run prints the resulting `https://…ts.net` URL.

It is **manual only**. A deploy restarts the container and drops any live agent
session, so pushing to `main` must not decide that for you.

## Operating it

Everything below runs over SSH; nothing here is required in normal use.

```bash
# Logs
docker logs -f cloudcli

# Restart after a reboot (the compose restart policy already handles this)
/opt/cloudcli/scripts/deploy.sh

# Roll back: point the image at a previous tag, then replay
sed -i 's|^CLOUDCLI_IMAGE=.*|CLOUDCLI_IMAGE=ghcr.io/ai-smarttalk/claudecodeui:sha-<older>|' /opt/cloudcli/.env
/opt/cloudcli/scripts/deploy.sh
```

`deploy.sh` reads `CLOUDCLI_IMAGE` from the persisted `.env` when the CI does not
supply one, which is what makes both of the above work unattended.

State lives in two named volumes and survives every image rollout:

- `cloudcli_home` → `/home/node` — `auth.db`, Claude Code sessions, git and SSH config
- `cloudcli_workspace` → `/workspace` — checked-out repositories

## Security notes

- **Registration is claimed, not left open.** The app allows
  `POST /api/auth/register` until a first user exists — an unclaimed instance
  hands a shell to whoever reaches it first. `seed-admin.cjs` closes that window
  during the deploy. Set the two admin secrets before the first run.
- **No public listener.** The container publishes to `127.0.0.1` only, and UFW
  denies incoming traffic except SSH and the tailnet interface. Even a flushed
  firewall would not expose the app.
- **Secrets never reach argv.** They are written to a `0600` file under `/run`,
  sourced by the script, and deleted by its `EXIT` trap.
- **The Docker socket is not mounted.** The in-app Docker panel therefore stays
  inert. Mounting it would grant the agent root on the host — decide that
  deliberately rather than inheriting it.
- **Unattended security upgrades are enabled**, since this host runs an agent
  with shell access.
