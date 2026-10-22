# Serve the dashboard on your own domain

Point a name you control (for example `agent.example.com`) at the dashboard instead of an IP
address, a `:port` or a tailnet name. soma-work needs one setting for this; everything else is
DNS and a reverse proxy you run next to it. Nothing about your domain goes into this repository.

## What soma-work needs

Set the public URL in the instance's `.env` and restart it:

```env
CONVERSATION_VIEWER_URL=https://agent.example.com
```

With an `https` value the server:

- builds every link it hands out from it — the Slack `dashboard` sign-in link, thread header
  `📋 작업 로그` deep links, conversation links and OAuth callbacks
  (`https://agent.example.com/auth/google/callback`)
- marks its cookies `Secure`
- accepts sign-in form posts only from that origin
- answers a browser `GET` that reaches it under any other host (an old `http://<ip>:<port>` or
  tailnet link) with a `302` to the same path on the domain. Loopback hosts, `/health` and
  WebSocket upgrades are left alone.

Keep the viewer bound to loopback (`CONVERSATION_VIEWER_HOST=127.0.0.1`, the default) when the
proxy runs on the same host.

## Sign-in providers (Google, Microsoft)

The OAuth callback follows the public URL: `https://agent.example.com/auth/google/callback`.
The provider rejects a callback it does not list (`redirect_uri_mismatch`), so add the new one to
the OAuth client before you switch. Slack `dashboard` sign-in links do not depend on this.

If you cannot update the provider console yet, keep the callback on the origin it already lists:

```env
SOMA_OAUTH_CALLBACK_BASE_URL=https://old-host.example.net:33443
```

The provider then returns to the old origin, which must still reach this instance (for example the
old tailnet name). The canonical-origin redirect forwards the callback, code and state intact, to
the public URL, and the code exchange repeats the same registered `redirect_uri`. That redirect is
only installed when `CONVERSATION_VIEWER_URL` is `https`; with an `http` public URL, start sign-in
from the old origin itself so the state cookie and the callback share a host. Remove the setting
once the new callback is registered — a callback origin you no longer control would receive codes.

## When the public URL does not reach the instance

After it starts listening, and every 10 minutes, the instance requests `<public URL>/health` and
looks for its own per-process id in the `x-soma-instance` response header. `/health` also reports
the last result as `publicUrl` (`unchecked`, `verified` or `mismatch`).

- Another server answered there (for example a hosting provider's 404 because the name's DNS points
  somewhere else): the log carries an error naming the URL and `/health` reports `mismatch`.
  Links stay on the public URL unless you opt in:

  ```env
  SOMA_PUBLIC_URL_FALLBACK=true
  ```

  Then, if `SOMA_OAUTH_CALLBACK_BASE_URL` answers as this instance, every link, the same-origin
  check, cookies and the canonical-origin redirect use that origin instead, so Slack links keep
  opening. Without a proven alternative, links stay on the public URL.
- The result is not certain — no answer, a name this host cannot resolve, `401`/`403`/`407`, a
  `5xx`, a redirect to another host or path, a response cut off mid-body, or `/health` behind a
  proxy that drops the header: nothing changes, and an established fallback stays. Split-horizon
  DNS and sign-in proxies keep their links. The probe reads at most a few KB of any answer.
- Once the public URL answers as this instance again, links return to it within one check. A
  Google or Microsoft sign-in already under way finishes on the origin it started on.

Fix the DNS record or the proxy, or correct `CONVERSATION_VIEWER_URL`; links already posted in Slack
keep the old address until their message is redrawn. The check catches misconfiguration; it is not a
security control — the instance id on `/health` is readable by anyone who can reach it.

## Before you expose it: authentication

A domain makes the dashboard reachable from the whole network. Check that the instance has
dashboard authentication before you add the proxy. At least one of these must be set:

- `DASHBOARD_JWT_SECRET` (Slack `dashboard` sign-in links)
- `CONVERSATION_VIEWER_TOKEN` (admin bearer token)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` or the Microsoft pair (OAuth)

With none of them set the server runs without authentication (`Authentication disabled` in the
startup log), and anyone who can reach the domain can read and act on every session. Generate a
secret with `openssl rand -hex 32`.

## DNS

Create an `A` record for the name pointing at the address your users reach the host on — for an
intranet, the host's LAN address. With a DNS provider that also proxies traffic (for example
Cloudflare), turn the proxy off for this record: a private address cannot be proxied.

## Reverse proxy and certificate

Any reverse proxy works. It must pass the original `Host` header (the redirect above compares it
with the configured URL) and must forward WebSocket upgrades (`/ws/dashboard`). A Caddy site block:

```caddyfile
agent.example.com {
	tls /path/to/certs/agent.example.com.crt /path/to/certs/agent.example.com.key
	reverse_proxy 127.0.0.1:33000
}
```

Caddy keeps `Host`, proxies WebSockets, and redirects `http` to `https` on its own.

A name that resolves to a private address cannot pass an HTTP challenge, so get the certificate
with a DNS challenge. For example, with `lego` and a Cloudflare token that may edit the zone:

```bash
CLOUDFLARE_DNS_API_TOKEN=... LEGO_PATH=/path/to/certs-store \
  lego run --accept-tos --email you@example.com --dns cloudflare -d agent.example.com --renew-days 30
```

Run the same command from a daily scheduled job, then `caddy reload --force`. Without `--force`
Caddy treats an unchanged config as a no-op and keeps serving the old certificate files.

## An instance on another host

If the instance runs on a host where you cannot run the proxy, serve its name from the proxy host
and carry the traffic over an SSH tunnel kept alive by the proxy host's service manager:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L 127.0.0.1:43300:127.0.0.1:33000 other-host
```

Point the `A` record at the proxy host and use `reverse_proxy 127.0.0.1:43300`. The instance keeps
its loopback bind and needs only `CONVERSATION_VIEWER_URL`.

## Check it

```bash
# On the proxy host, without depending on DNS:
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  --resolve agent.example.com:443:127.0.0.1 https://agent.example.com/dashboard
# Expect 302 to https://agent.example.com/login (signed out) — same host, not an IP or tailnet name.

# An old link now lands on the domain:
curl -sS -o /dev/null -w '%{redirect_url}\n' http://<old-host>:<port>/dashboard
```

In Slack, `dashboard` should answer with a link on the new domain.
