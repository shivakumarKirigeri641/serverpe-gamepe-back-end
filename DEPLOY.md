# Deploying MastiPe

Four commands on a clean machine. Nothing to compile — this is plain
JavaScript, so there is no build step and no artefact to ship.

```bash
npm install
cp .env.example .env     # then fill it in, see below
npm run setup            # creates the database and the tables
npm start
```

`npm run setup` is **safe to run again**. It creates the database only if it is
missing, applies the schema only if the database is empty, and then checks your
configuration and tells you what is wrong. It never drops anything.

---

## What you must set in `.env`

Everything else has a working default.

| Key | Why it matters |
|---|---|
| `PGDATABASE` `PGUSER` `PGPASSWORD` | `PGHOST` defaults to localhost, `PGPORT` to 5432 |
| `PUBLIC_BASE_URL` | **The single most common mistake.** Board links are opened on players' phones, so this must be a URL a phone can reach — your ngrok https URL while testing, `https://api.mastipe.in` in production. Never `localhost`. |
| `ADMIN_PASSCODE` | Without it the admin panel cannot be used at all |
| `BOARD_LINK_SECRET` | Any long random string. It signs every player's board and report link; change it and all outstanding links stop working |
| `WHATSAPP_*` | See below. Leave `WHATSAPP_ACCESS_TOKEN` empty to run without Meta at all |

`npm run setup` warns about each of these if it is missing or looks wrong, so
run it and read the last section of its output.

`.env.example` lists **every** key the server reads, generated from the running
configuration so the two cannot drift. A blank value means you have to supply
it; anything already filled in is a working default worth keeping.

### Also worth setting before launch

Not required to boot, but each one is silently wrong if left empty.

| Key | What happens if you skip it |
|---|---|
| `SITE_BASE_URL` | Policy links fall back to this API's own copy. Meta and Razorpay expect them on your own domain — set `https://mastipe.in` |
| `ADMIN_PANEL_URL` | Alert emails lose their "Open the admin panel" button. Harmless, but you will want it |
| `MAIL_HOST` `MAIL_USER` `MAIL_PASSWORD` | No operator alerts, no daily summary, no copy of support tickets. Mail is logged instead of sent |
| `ALERT_RECIPIENT` | Where those alerts go. Falls back to `ADMINMAIL` |
| `MAIL_FROM_NAME` | The bold name in the inbox. Defaults to `ServerPe App Solutions` |
| `SUPPORT_EMAIL` | The reply-to on support mail |
| `APP_TIMEZONE` | Defaults to `Asia/Kolkata`, and is **pinned onto every database connection** — so timestamps read the same here as they do on a server whose Postgres defaults to UTC |

---

## The demo videos

Four files live in `src/media/` and are served at
`<API_BASE_PATH>/public/media/`:

```
mastipe-demo.mp4          mastipe-demo-cover.png       # English
mastipe-demo-hi.mp4       mastipe-demo-hi-cover.png    # Hindi
```

They are deployed by hand — copy them into `src/media/` alongside the code.
Nothing references them by any other path, and both the how-to-play page and
the marketing site read them from here, so there is one copy rather than two
that drift.

If a file is missing the page still renders: the `<video>` shows its poster and
plays nothing, and the request returns a clean 404 rather than a 500.

The marketing site points at **this** server for them, so its `VITE_API_BASE`
must be set in production — otherwise it will look for the videos on its own
origin and find nothing.

---

## Connecting WhatsApp

1. `npm start` — the banner prints the exact callback URL and verify token.
2. In the Meta app dashboard → WhatsApp → Configuration → Webhook, paste:
   - **Callback URL**: `<PUBLIC_BASE_URL><API_BASE_PATH><WHATSAPP_WEBHOOK_PATH>`
   - **Verify token**: your `WHATSAPP_VERIFY_TOKEN`
3. **Subscribe to the `messages` field.** This is separate from saving the URL,
   and it is the step most often missed — without it Meta accepts the webhook
   and then never delivers anything.
4. Message `hi` to your business number.

### Two safety nets while testing

- **No access token** → outbound messages are logged to the console instead of
  sent. A whole game is playable with no Meta account attached.
- **`WHATSAPP_ALLOWED_RECIPIENTS`** → only those numbers can ever receive a
  message. Anything else is dropped and logged. Clear the variable in
  production, or nobody will hear from you.

---

## Behind ngrok

```bash
ngrok http 5006
```

Set `PUBLIC_BASE_URL` to the https URL ngrok prints and restart. The same
tunnel serves the webhook *and* the game boards, so it is one URL doing two
jobs. Free ngrok changes that URL on every restart — the server refuses to
start if `PUBLIC_BASE_URL` says localhost while WhatsApp is live, which is the
mistake this catches.

---

## The two front ends

Both are Vite apps with their own `.env`. **`VITE_PROXY_TARGET` must point at
this server**, and both now print their target on startup so a mismatch is
visible immediately.

```bash
cd ../serverpe-gamepe-admin-front-end && npm install && npm run dev   # :5174
cd ../serverpe-gamepe-front-end       && npm install && npm run dev   # :5175
```

For production build them (`npm run build`) and serve `dist/` from any static
host, with `VITE_API_BASE` set to this server's origin and
`ADMIN_CORS_ORIGINS` here listing the panel's origin.

`VITE_API_BASE` is not optional for the marketing site: the demo videos, the
policies and the testimonials all come from this server, and with it unset the
site asks its own origin for them and quietly shows nothing.

Both configs read the target through Vite's `loadEnv`, not `process.env` —
Vite does not populate `process.env` when evaluating a config file, so the
fallback wins silently and the panel talks to the wrong back-end. Both print
their target on startup; read that line.

---

## Running it under pm2

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup      # survive a reboot
pm2 logs mastipe-api
```

The config is committed on purpose. A hand-written pm2 entry is how a
deployment ended up pointing at `dist/index.js`, a path that has never
existed here — **there is no build step**, and `src/index.js` is the program.

`instances: 1` in that file is a correctness constraint, not a capacity
choice. Live board updates live in one process's memory, so cluster mode
would leave most of a table watching a board that stopped moving. See the
last section of this document.

## Every command

| Command | Does |
|---|---|
| `npm run setup` | Create database + tables if missing, then check config. Safe to repeat. |
| `npm start` | API, board, admin API and the draw scheduler, in one process |
| `npm run dev` | The same, restarting on file changes |
| `npm run db:reset` | Shows what it *would* destroy, then stops |
| `npm run db:reset -- --yes` | **Destroys all data** and rebuilds from `schema.sql` |
| `npm run db:reset -- --purge` | The same, and also drops tables left by any previous app |
| `npm test` | Game-logic and webhook unit tests |

There is no migration chain. The whole schema is `src/db/schema.sql`; change it
and re-run `db:reset`. **Switch to additive migrations before you have players
whose data you care about** — `db:reset` cannot be undone.

---

## Upgrading an existing deployment

```bash
git pull
npm install
npm run setup     # applies the schema only if the database is empty
npm start
```

If the schema changed and the database already has tables, `setup` will leave
them alone and say so. Applying that change is a decision you have to make:
either write the `ALTER TABLE` by hand, or — while still pre-launch —
`npm run db:reset -- --yes` and accept losing the data.

---

## Health checks

| URL | Purpose |
|---|---|
| `/healthz` | Also at the root, for load balancers. Returns 503 if the database is unreachable |
| `<API_BASE_PATH>/public/health` | The same, in the public API's envelope |

## Running more than one instance

The draw scheduler uses `FOR UPDATE SKIP LOCKED`, so several processes divide
the games between them safely with no extra infrastructure.

**One thing does not scale yet:** live board updates are held in each process's
memory, so two instances would each only reach their own players. Fixing it is
swapping `broadcast()` in `src/services/live.service.js` for Postgres
`LISTEN/NOTIFY` — every other module already goes through that one function.
Until then, run a single instance.
