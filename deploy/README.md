# Childhood Arcade production assets

These files describe the reviewed production topology for `arcade.abcds.de`:

```text
browser -> Nginx/TLS (43.159.2.240)
        -> 127.0.0.1:19097 on the proxy host
        -> restricted SSH -L tunnel
        -> 127.0.0.1:19097 on 160.236.110.53
        -> Childhood Arcade systemd service
```

They are templates, not an unattended installer. Back up the current effective
configuration, substitute secrets locally on the target host, validate every
stage, and reload only the service whose new configuration passed validation.
No file in this directory contains a real password or private key.

## Application layout

Use an unprivileged `childhood-arcade` account and keep releases immutable:

```text
/srv/childhood-arcade/current -> releases/<commit>
/srv/childhood-arcade/releases/<commit>/
/srv/childhood-arcade/runtime/node-v24/
/srv/childhood-arcade/shared/data/{uploads,bios,saves,cores}
/etc/childhood-arcade.env
```

Install `deploy/childhood-arcade.env.example` as
`/etc/childhood-arcade.env`, replace the password placeholder before the first
start, and set ownership to `root:childhood-arcade` with mode `0640` (or root-only
`0600` if the service manager is the only reader). `ADMIN_PASSWORD` seeds a new
database; changing it after the first boot does not change an existing user's
password.

Install the service and health monitor as follows:

```bash
install -o root -g root -m 0644 deploy/systemd/childhood-arcade.service \
  /etc/systemd/system/childhood-arcade.service
install -o root -g root -m 0755 deploy/bin/childhood-arcade-healthcheck.sh \
  /usr/local/libexec/childhood-arcade-healthcheck
install -o root -g root -m 0644 deploy/systemd/childhood-arcade-healthcheck.service \
  /etc/systemd/system/childhood-arcade-healthcheck.service
install -o root -g root -m 0644 deploy/systemd/childhood-arcade-healthcheck.timer \
  /etc/systemd/system/childhood-arcade-healthcheck.timer
systemd-analyze verify /etc/systemd/system/childhood-arcade.service \
  /etc/systemd/system/childhood-arcade-healthcheck.service \
  /etc/systemd/system/childhood-arcade-healthcheck.timer
systemctl daemon-reload
systemctl enable --now childhood-arcade.service childhood-arcade-healthcheck.timer
```

The application binds only to `127.0.0.1:19097`. The timer makes at most three
bounded HTTP requests per run. Only after all three fail does it use
`systemctl try-restart childhood-arcade.service`; it never starts or restarts an
unrelated service.

## Node.js 24 and the native SQLite ABI

The unit intentionally does not use the system `PATH`. Its `ExecStart` selects
`/srv/childhood-arcade/runtime/node-v24/bin/node`, which should be a verified
Node.js 24.19.0 installation (or a reviewed Node 24 patch update). Node 24 uses
module ABI **137**. Install `better-sqlite3` with this same runtime; a
`node_modules` tree produced by Node 20 or another ABI can fail at startup.

Use the application-local runtime for installation and verification:

```bash
export PATH=/srv/childhood-arcade/runtime/node-v24/bin:$PATH
node --version
node -p 'process.versions.modules'   # expected: 137
npm ci
npm audit --omit=dev
npm run build
node --check server/index.js
sh -n deploy/bin/childhood-arcade-healthcheck.sh
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.exec('select 1'); db.close()"
npm prune --omit=dev
```

Do not reuse the MCSManager-bundled Node.js runtime or its dependencies.

## ROM and BIOS boundary

The upstream repository contains BIOS files under `data/bios/`. They must not be
included in the production release, copied to the shared data directory, or
added to this fork. ROMs, proprietary BIOS images, saves, and an existing SQLite
database must also be excluded from release archives. Deploy only source code
and the reviewed emulator cores; users must provide ROM/BIOS content for which
they have the legal right to use.

A release copy should explicitly exclude at least:

```text
data/bios/**
data/uploads/**
data/saves/**
data/app.db*
```

## Restricted SSH tunnel

Generate a dedicated Ed25519 key as the `childhood-arcade-tunnel` user on the
proxy host. Never copy an operator's private key. Pin the application host key in
`/var/lib/childhood-arcade-tunnel/.ssh/known_hosts`, and install the public key on
the application host with a per-key restriction such as:

```text
restrict,port-forwarding,permitopen="127.0.0.1:19097" ssh-ed25519 PUBLIC_KEY_PLACEHOLDER
```

Install `deploy/sshd/60-childhood-arcade-tunnel.conf` on the application host.
The safe validation order is:

1. Keep the existing administrator SSH session open.
2. Run `sshd -t`; do not reload on failure.
3. Reload SSH, then test the dedicated key and `ssh -N -L` in a second session.
4. On the proxy, confirm `curl http://127.0.0.1:19097/api/health` returns 200.
5. Only then install, enable, and start
   `deploy/systemd/childhood-arcade-tunnel.service` on the proxy host.

The service uses strict host-key checking, keepalives,
`ExitOnForwardFailure=yes`, and `Restart=always`. The SSHD match block permits
only local forwarding to the one loopback application port and forces any
requested command to `/bin/false`.

## Two-stage Nginx and certificate rollout

The proxy already hosts other sites, so add one new file only (for example,
`/etc/nginx/conf.d/60-childhood-arcade.conf`) and never edit an existing virtual
host for this deployment.

### Stage 1: ACME bootstrap

1. Confirm `arcade.abcds.de` resolves to `43.159.2.240` from a public resolver.
2. Save `nginx -T` and the current status/certificate of existing sites.
3. Install `deploy/nginx/arcade-bootstrap.conf` as the new file.
4. Run `nginx -t`; reload Nginx only if it succeeds.
5. Request the certificate with the existing webroot:

   ```bash
   certbot certonly --webroot -w /var/www/acme -d arcade.abcds.de
   ```

The bootstrap host serves only `/.well-known/acme-challenge/`; every other
request returns 503, so an unauthenticated HTTP application is never exposed.

### Stage 2: HTTPS proxy

1. Confirm the certificate and key exist below
   `/etc/letsencrypt/live/arcade.abcds.de/`.
2. Replace only the new bootstrap file with `deploy/nginx/arcade.conf`.
3. Run `nginx -t`; if it fails, restore the bootstrap file and do not reload.
4. Reload Nginx, verify HTTPS and WebSocket upgrade, then recheck every existing
   site's status and certificate against the baseline.

The production template allows `101m` at Nginx so a 100 MiB application upload
has room for multipart overhead. It replaces client-supplied
`X-Forwarded-For` with `$remote_addr`. The room WebSocket path has
`access_log off` and a `crit`-only error log because its query string currently
contains the room password. The template reuses the proxy's existing global
`$connection_upgrade` map; do not define a duplicate map in this site file.

## Public registration risk

`POST /api/auth/register` is currently public. It has no invitation check,
approval queue, or endpoint-specific rate limit, so a public deployment can be
used to create unwanted accounts. Keep it open only for the intended friend
onboarding window. A short-term Nginx block after onboarding is:

```nginx
location = /api/auth/register {
    return 403;
}
```

An exact location takes precedence over the general proxy location. If selected
friends still need registration, proxy this exact location with a temporary IP
allowlist instead. The preferred application-level follow-up is a registration
toggle or invitation code plus rate limiting; that is more reliable than IP
allowlisting for mobile users.

## Verification and rollback

Before considering the rollout complete, verify:

```bash
systemctl is-enabled childhood-arcade.service childhood-arcade-healthcheck.timer
systemctl is-active childhood-arcade.service childhood-arcade-healthcheck.timer
curl --fail http://127.0.0.1:19097/api/health
ss -lntp | grep '127.0.0.1:19097'
journalctl -u childhood-arcade.service -u childhood-arcade-healthcheck.service --since today
```

On the proxy, also verify the tunnel unit, the loopback health endpoint, HTTPS,
the room WebSocket, and all pre-existing Nginx sites. Do not reboot either host
just to prove enablement.

For application rollback, repoint `/srv/childhood-arcade/current` to the previous
immutable release and restart only `childhood-arcade.service`. For Nginx or SSHD
rollback, restore the single new file from its saved copy, validate the complete
configuration, and reload only after validation succeeds.
