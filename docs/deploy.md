# Deploying MastiPe

**One file: `.env`.** The back-end reads `.env` and nothing else, on every
machine. What differs between a laptop and the server is the contents of that
file, not which file is loaded — so there is no flag to forget and no second
file that might be the one actually in force.

| | Local `.env` | Server `.env` |
| --- | --- | --- |
| API origin | `http://localhost:5009` | `https://api.mastipe.in`, port **5006** |
| `NODE_ENV` | `development` | `production` |
| `WHATSAPP_ALLOWED_RECIPIENTS` | your test numbers | **empty** |
| Razorpay | `rzp_test_…` | `rzp_live_…` |

`.env` is gitignored and never travels with `git pull`; you put the server's
copy there once, by hand. `.env.example` is committed and holds no secrets —
only which variables exist. The front-ends keep Vite's own convention
(`.env` locally, `.env.production` for a build), which is separate from this.

Environment variables still win over the file, so a systemd unit or a one-off
`VAR=x npm start` can override a value without editing anything.

## The order that matters

The server migrates on boot, and `npm run build` is what puts the migrations
where the built server can find them (`scripts/copy-assets.mjs`). `tsc` alone
emits JavaScript and silently leaves `dist/db/migrations` empty, which starts
cleanly against an unmigrated database — so never deploy a `dist/` built by
anything but `npm run build`.

## Files that must outlive a deploy

`src/uploads/` holds every invoice and report PDF ever issued, addressed by
invoice number. If the deploy replaces the working directory, those numbers
stop resolving and a GST invoice cannot be reproduced. Either keep the folder,
or move it off the deploy path with `UPLOADS_DIR`.

`src/images/` and `src/assets/fonts/` are read at runtime from the working
directory too — the deployed tree needs `src/`, not only `dist/`.

## The demo films

`src/media/*.mp4` is build output and is gitignored: two five-megabyte files
that are regenerated whenever a scene is retimed, and git would keep every
version of them forever. They do not arrive with `git pull`, so copy them once
per change:

```bash
scp src/media/mastipe-demo.mp4 src/media/mastipe-demo-hi.mp4     root@srv:/var/www/serverpe-gamepe-back-end/src/media/
```

Without them the marketing site and the demo page show the cover image (which
*is* committed) and the video fails to play. Re-render with
`npx tsx scripts/make-demo-video.ts`; the soundtrack is whatever audio file
sits in `src/assets/music/`, which is gitignored and never served.

## Running

```bash
# Local
npm run dev

# Production
npm run build
npm run migrate             # migrations first, always
npm start
```

The application loads `.env` itself, with dotenv, so no `--env-file` flag is
needed and these commands work on any supported Node — including the older one
on the production server, which is shared with another live service and not
ours to upgrade in passing.

To run locally against production values, put them in `.env` — and remember
that is exactly what makes it dangerous: the same command then talks to the
live database and the live WhatsApp number.

## Before the first production boot

`.env.example` carries `CHANGE_ME` against every secret, and the server
**refuses to start** while any remain. Booting anyway would mean a live service
with an admin passcode published in this repository. The error names exactly
which ones are outstanding:

```
Refusing to start: WHATSAPP_ACCESS_TOKEN, BOARD_LINK_SECRET, ADMIN_API_KEY,
ADMIN_PASSCODE, DATABASE_URL, NOREPLYMAIL_PASSWORD, ADMINMAIL_PASSWORD
still contain CHANGE_ME in .env.
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
- `api.mastipe.in` → this server on port 5006, behind TLS (`PORT` in the server's `.env`;
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
