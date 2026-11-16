# Cloudflare Access

All personal web entry points use one self-hosted Access application:

```text
ACP Claw Unified
```

Human login is the built-in one-time PIN provider. The application has two
allowed email identities and a one-month session. Because all hostnames belong
to the same multi-domain application, authenticating on one hostname issues
access to the others without another prompt.

## Protected hosts

- `home.afarfabula.org`
- `code.afarfabula.org`
- `3090gpu.afarfabula.org`
- `overleaf.afarfabula.org`
- `browser.afarfabula.org`

The internship jobs portal remains on GitHub Pages and is intentionally not
part of this Access application.

## Verify

```bash
node tools/cloudflare-access/verify.mjs
```

Every hostname should return a redirect to the team domain
`qyyyyq.cloudflareaccess.com`.

## Robot access

Automated clients must use an Access Service Token, not a human session cookie.
Store the private token JSON outside Git:

```text
~/.acp-claw/cloudflare-access/service-token.json
```

Required fields:

```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

The file and parent directory must be mode `0600` and `0700`. Add a Service
Auth policy containing that token to `ACP Claw Unified`. Requests then carry:

```text
CF-Access-Client-Id: <client_id>
CF-Access-Client-Secret: <client_secret>
```

Never expose Chrome DevTools port `9223` or noVNC port `6080` directly; only
the Access-protected hostname should be public.
