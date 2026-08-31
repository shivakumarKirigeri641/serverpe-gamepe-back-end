# Deploying MastiPe

Two environments, two files, one rule: **the file decides, not the machine.**

| | Local | Production |
| --- | --- | --- |
| Back-end | `.env` | `.env.prod` |
| API origin | `http://localhost:5009` | `https://api.mastipe.in` (server listens on **5006**) |
| Marketing site | `.env` (proxied) | `.env.production` → `https://mastipe.in` |
| Admin panel | `.env` (proxied) | `.env.production` → `https://admin.mastipe.in` |

`.env` and `.env.prod` are gitignored. `.env.example` and the front-ends'
`.env.production` are committed — they hold no secrets, only which variables
exist and which host to call.

## Running

```bash
# Local — reads .env
npm run dev

# Production — reads .env.prod
npm run build
npm run migrate:prod        # migrations first, always
npm run start:prod
```

`--env-file` is Node's own flag, so these work identically in PowerShell, cmd
and bash. No `VAR=value` prefixes, which do not work on Windows.

To run locally *against* production config (rarely, and carefully):
`npm run dev:prod`.

## Before the first production boot

`.env.prod` ships with `CHANGE_ME` against every secret, and the server
**refuses to start** while any remain. Booting anyway would mean a live service
with an admin passcode published in this repository. The error names exactly
which ones are outstanding:

```
Refusing to start: WHATSAPP_ACCESS_TOKEN, BOARD_LINK_SECRET, ADMIN_API_KEY,
ADMIN_PASSCODE, DATABASE_URL, NOREPLYMAIL_PASSWORD, ADMINMAIL_PASSWORD
still contain CHANGE_ME in .env.prod.
```

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`BOARD_LINK_SECRET` and `ADMIN_API_KEY` must be different values. The first
signs the links that open a player's ticket; the second is the key to every
player's phone number.

## The one that fails silently

`WHATSAPP_ALLOWED_RECIPIENTS` **must be empty in production.** It is the
development guard that blocks sends to anyone not listed. Left set, every real
player is ignored — messages are recorded as failed, no error is raised, and
the service looks healthy while reaching nobody. Production now refuses to start
if it is non-empty, because this failure is invisible from the outside.

## DNS and Meta

- `mastipe.in` → the marketing site build (`dist/`)
- `admin.mastipe.in` → the admin panel build (`dist/`)
- `api.mastipe.in` → this server on port 5006, behind TLS (`PORT` in `.env.prod`;
  development still uses 5009, so the reverse proxy must name 5006 explicitly)

Webhook URL to paste into the Meta dashboard:

```
https://api.mastipe.in/serverpe/platform/mastipe/v1/public/users/bot/whatsapp/webhook
```

Verify token: whatever `WHATSAPP_VERIFY_TOKEN` is set to. Subscribe to the
**messages** field — without it the webhook verifies successfully and then
delivers nothing, which reads exactly like a working integration.

## After deploying

- `GET https://api.mastipe.in/serverpe/platform/mastipe/v1/public/health`
- Send `hi` from a real phone and check a reply arrives.
- Open the admin panel, sign in, confirm the **Free trial** page shows the
  signup count.
- Check `ADMIN_CORS_ORIGINS` contains the panel's real origin. If it does not,
  the login screen reports the server as unreachable rather than as blocked.
