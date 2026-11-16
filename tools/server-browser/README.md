# Server Browser

Persistent virtual Chrome hosted by Cloudflare Access at:

```text
https://browser.afarfabula.org/vnc.html?autoconnect=1&resize=scale&reconnect=1
```

Cloudflare Access is the authentication boundary. Inside the machine, x11vnc
listens on a mode-0600 Unix socket rather than TCP and noVNC connects through
that socket. There is no VNC password prompt.

The browser profile, Chrome binary, noVNC assets and Python environment remain
under `/home_ext/quyanyi/server-chrome`; executable scripts and systemd units
are maintained here in acp-claw.

## Install / restart

```bash
./install-service.sh
./status.sh
```

## Local diagnostics

```bash
curl http://127.0.0.1:6080/
curl http://127.0.0.1:9223/json/version
```

Cloudflare Access must remain enabled for `browser.afarfabula.org`; do not
publish port 6080 directly.
