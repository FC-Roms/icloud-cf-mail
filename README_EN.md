# iCloud Cloudflare Mail Worker

This project is a Cloudflare Email Worker that receives mail through Cloudflare Email Routing, stores the full HTML email body in D1, forwards the original message to a verified destination mailbox, and exposes a protected web/API view for querying mail by iCloud alias.

The Worker is designed for iCloud Hide My Email style recipients, for example:

```txt
To: Hide My Email <alias-name@icloud.com>
```

Only the normalized `@icloud.com` recipient address is queryable. Sender addresses, reply-to addresses, route-domain addresses, and envelope forwarding addresses are not queryable through the public API.

## What It Stores

The D1 database stores:

- Normalized `@icloud.com` recipient index.
- Full HTML email body.
- Plain-text fallback body.
- Internal metadata needed for debugging and forwarding.

The API intentionally does not expose sender/recipient metadata such as `from`, `to`, `reply-to`, `envelope-to`, `message-id`, size, attachment count, raw headers, or recipient tags.

## Public API Shape

Authenticated query:

```txt
GET /logs?mail=alias-name@icloud.com
Authorization: Bearer <VIEW_TOKEN>
```

Response:

```json
{
  "messages": [
    {
      "id": "message-id",
      "subject": "Example subject",
      "date": "Sun, 17 May 2026 13:38:00 +0700",
      "htmlBody": "<!doctype html>...",
      "receivedAt": "2026-05-17T06:38:00.000Z"
    }
  ],
  "logs": [],
  "pagination": {
    "limit": 10,
    "hasMore": false,
    "nextCursor": null
  }
}
```

`logs` is kept as a compatibility alias for `messages`.

## Security Defaults

- `VIEW_TOKEN` is required for `/logs` and `/messages`.
- `VIEW_TOKEN` must be configured as a Wrangler secret.
- Querying anything outside `@icloud.com` returns `400`.
- There is no unauthenticated all-mail listing endpoint.
- No public CORS is enabled.
- HTML email is rendered in a sandboxed iframe without scripts.
- Sensitive deployment values are not included in this handoff bundle.

## Files

- `worker.js`: Cloudflare Worker code.
- `migrations/0001_icloud_mail.sql`: D1 schema.
- `scripts/create-d1.js`: Helper to create D1 and update `wrangler.toml`.
- `scripts/test-worker.js`: Local tests for parsing, query rules, auth, privacy, and pagination.
- `wrangler.toml`: Sanitized Worker configuration template.
- `.dev.vars.example`: Local environment template.

## Configuration

Edit `wrangler.toml` before deploying:

```toml
name = "your-worker-name"
main = "worker.js"
compatibility_date = "2026-05-03"
workers_dev = true
preview_urls = false

[vars]
WORKER_ID = "your-worker-name"
WORKER_URL = "https://your-worker-name.your-subdomain.workers.dev"
ADMIN_EMAIL = "verified-destination@example.com"
BLOCKED_DOMAINS = "spam.com,fake-mailer.com"
SPAM_WORDS = "casino,crypto bonus,buy now,loan approved"
MAX_MESSAGE_SIZE_BYTES = "10485760"

[[d1_databases]]
binding = "MAIL_DB"
database_name = "your-worker-name_mail"
database_id = "00000000-0000-0000-0000-000000000000"
```

Set the view token as a secret:

```bash
wrangler secret put VIEW_TOKEN
```

`ADMIN_EMAIL` must be a verified Cloudflare Email Routing destination address.

## Install

```bash
npm install
```

## Create And Migrate D1

```bash
npm run d1:create
npm run d1:migrate
```

The `d1:create` script creates a D1 database and replaces the `MAIL_DB` binding in `wrangler.toml`.

## Test

```bash
npm test
npm run check
```

`npm run check` runs the local test suite and a Wrangler deploy dry-run.

## Deploy

```bash
wrangler secret put VIEW_TOKEN
npm run deploy
```

After deploy, configure Cloudflare Email Routing for your domain:

1. Enable Email Routing.
2. Verify `ADMIN_EMAIL` as a destination address.
3. Add a routing rule or catch-all rule.
4. Set the action to send mail to this Worker.

The web UI is served from:

```txt
https://your-worker-name.your-subdomain.workers.dev/
```

Enter an `@icloud.com` email address and the `VIEW_TOKEN` to view matching messages.

## Notes For Handoff

This bundle uses placeholders for:

- Worker URL.
- Cloudflare account/subdomain.
- Destination email.
- D1 database ID.
- View token.
- Real production domain.

Replace placeholders with the recipient environment's own Cloudflare values before deployment.
