# Setup

## 1. Local services

Postgres and Redis must be running. The database is created for you on first
migrate only if it already exists — create it once by hand:

```sql
CREATE DATABASE serverpe_gamepe;
```

## 2. Environment

```bash
cp .env.example .env
```

Set at minimum:

```
DATABASE_URL=postgres://postgres:<password>@localhost:5432/serverpe_gamepe
REDIS_URL=redis://localhost:6379
```

Leave the WhatsApp values empty for now. With no `WHATSAPP_ACCESS_TOKEN` the
send client runs in **dry-run mode**: every outbound message is logged instead
of sent, so the whole game loop is testable offline.

## 3. Run

```bash
npm install
npm run migrate     # also runs automatically on boot
npm run dev         # API + draw worker in one process
curl localhost:3000/health
```

## 4. ngrok

```bash
ngrok http 3000
```

Copy the `https://` forwarding URL. Your webhook callback URL is:

```
https://<your-ngrok-subdomain>.ngrok-free.app/webhook/whatsapp
```

The URL changes every time you restart ngrok on the free plan, and you must
re-save it in Meta each time. A reserved domain avoids that.

## 5. Meta app configuration

In **developers.facebook.com → your app → WhatsApp → Configuration**:

1. **Callback URL** — the ngrok URL above.
2. **Verify token** — any string; put the same value in `WHATSAPP_VERIFY_TOKEN`.
3. Click **Verify and save**. The server answers the `GET` handshake; you should
   see `whatsapp webhook verified` in the log.
4. **Webhook fields** — subscribe to **`messages`**. Without this, nothing arrives.

Then from **API Setup**, copy into `.env`:

```
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_ACCESS_TOKEN=...          # temporary token lasts 24h
WHATSAPP_APP_SECRET=...            # App Settings > Basic
```

Restart the server after editing `.env`.

> The temporary access token expires in 24 hours. For anything beyond a first
> test, create a System User in Business Settings and issue a permanent token.

### Test numbers

While the app is in development mode you can only message numbers added under
**API Setup → To**. Add your own number there first, then message the test
number from WhatsApp with `hi`.

## 6. Signature verification

`WHATSAPP_APP_SECRET` makes the server reject webhook posts that Meta didn't
sign. It is skipped when the value is empty, which is what lets the simulated
webhook tests work — set it before anything reachable goes live.

## 7. WhatsApp Flows (optional)

The game is fully playable without a Flow — it falls back to a monospace board
plus reply buttons. To enable the richer board screen:

1. **WhatsApp Manager → Flows → Create Flow**, start from a blank flow.
2. Paste the contents of `src/whatsapp/flows/game-flow.json` into the Flow JSON
   editor and save.
3. **Publish** the flow. A draft flow can only be opened by admins.
4. Copy the Flow ID into `WHATSAPP_FLOW_ID` in `.env` and restart.

This is an **endpoint-less flow**: all screen data is sent with each message and
answers come back in the normal webhook as an `nfm_reply`. No data-exchange
endpoint, no RSA key exchange.

If a Flow send fails for any reason, that player automatically gets the text
fallback for that number — a broken Flow never stalls a game.

## 8. Tuning a round

| Variable | Effect |
| --- | --- |
| `DRAW_INTERVAL_SECONDS` | Seconds waited for answers before the next number (default 8) |
| `DEFAULT_GAME_KEY` | Which game `play` starts |
| `MONETIZATION_ENABLED` | Master switch for entry fees and cash prizes |
| `FREE_TRIAL_ENDS_AT` | Fees stay off until this passes, even if the switch is on |

A tick advances early as soon as every seated player has answered, so with a
small group the game runs faster than the interval suggests.

## Troubleshooting

**Webhook verification fails** — `WHATSAPP_VERIFY_TOKEN` must match exactly, and
the URL must end in `/webhook/whatsapp`.

**Verified, but no messages arrive** — you almost certainly did not subscribe to
the `messages` webhook field.

**Messages arrive but nothing is sent back** — check for `[whatsapp:dry-run]` in
the log. That means `WHATSAPP_ACCESS_TOKEN` is empty.

**`(#131030) recipient not in allowed list`** — add the number under API Setup.

**Duplicate rooms from one "hi"** — Redis is down. De-duplication of Meta's
webhook retries depends on it.
