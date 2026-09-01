# Reading the logs

Two layers, on purpose.

**The story** — one line per thing that happened, tagged with a stable `evt`
key. This is what to watch during a game or a launch.

```
msg.in       9198••••2415 (new) "hi"
msg.out      9198••••2415 buttons
game.created room MP4K9T by host, 12 expected
game.started room MP4K9T with 3 players
game.draw    room MP4K9T #1 called 47 (1/90) → 3 players
msg.out      9199••••0271 text
game.claim   room MP4K9T middle_line AWARDED
game.claim   room MP4K9T top_line REJECTED
game.ended   room MP4K9T completed
```

**The detail** — the existing structured logs (`whatsapp send failed`,
`razorpay webhook handled`, `redis error`, and so on), for when a line in the
story is not the one you expected.

Phone numbers are masked everywhere: `9198••••2415`. Enough to follow one
person through a session, not enough to identify them from a log pasted into a
chat.

## Watching

```bash
journalctl -u mastipe -f                    # everything, live
journalctl -u mastipe -f | grep -E 'msg\.'  # only the conversation
journalctl -u mastipe -f | grep game.draw   # only the numbers being called
journalctl -u mastipe --since '1 hour ago' | grep -i error
```

Under pm2, replace `journalctl -u mastipe` with `pm2 logs mastipe`.

Following one room from start to finish:

```bash
journalctl -u mastipe --since today | grep MP4K9T
```

Counting a day:

```bash
journalctl -u mastipe --since today | grep -c msg.in       # messages received
journalctl -u mastipe --since today | grep -c game.started # games played
```

## Pretty or JSON

`LOG_PRETTY=true` gives the readable form above; unset it (or `false`) for
one JSON object per line, which is what a log shipper wants. Development
defaults to pretty, production to JSON — set it explicitly on the server while
you are watching a launch.

`LOG_LEVEL=debug` adds the noisy detail, including full webhook bodies. That
means players' message contents on disk, so it is for a short debugging session
and not a setting to leave on.

## What each event means

| `evt` | Written when |
| --- | --- |
| `msg.in` | A player's message arrived and was attributed to them |
| `msg.out` | A message was accepted by the WhatsApp Cloud API |
| `game.created` | A host opened a room (before anyone joins) |
| `game.started` | The host pressed Start; the bot is now the caller |
| `game.draw` | A number was called and fanned out to the room |
| `game.claim` | A prize was claimed — `AWARDED` or `REJECTED` |
| `game.ended` | The game finished or was cancelled, once |

## The silences worth noticing

- `msg.in` with no `msg.out` after it → the bot received but did not reply.
- `game.started` with no `game.draw` → the draw worker or Redis is down.
- `game.draw` climbing but no `msg.out` → sends are failing; look for
  `whatsapp send failed` in the detail layer.
- Nothing at all after a player messages → Meta is not delivering; check the
  webhook subscription rather than the server.
