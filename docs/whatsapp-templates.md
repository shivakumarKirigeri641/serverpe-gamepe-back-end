# WhatsApp message templates

Templates are only needed to message someone **outside the 24-hour window** —
that is, when they have not messaged you recently. Everything the game itself
sends (the invite, the summary, the rating prompt) happens seconds after the
player messaged us, so it needs no template at all.

The one case that genuinely does is announcing that maintenance is over,
because by then nobody has messaged in for hours.

---

## `platform_back_online`

Create this in **Meta Business Manager → WhatsApp Manager → Message templates**.

| Field | Value |
|---|---|
| **Name** | `platform_back_online` |
| **Category** | **Utility** — *not* Marketing. It is a service update about something the user already uses; Marketing costs more and can be blocked by the user's marketing opt-out. |
| **Language** | English (`en`) — add `en_US` too if Meta asks |

### Header — none

A header pushes the useful text below the fold in the notification preview.
Skip it.

### Body

```
Hi {{1}}, MastiPe is back online.

Maintenance is finished and {{2}} is ready to play again. Your tickets, game history and prizes are all exactly as you left them.

Reply *hi* to start a game.
```

| Parameter | Meaning | Sample for approval |
|---|---|---|
| `{{1}}` | Player's first name | `Priya` |
| `{{2}}` | Game name | `Tambola` |

> **Samples are mandatory.** Meta rejects the template if you submit it without
> example values for every variable.

### Footer

```
You're receiving this because you played on MastiPe.
```

### Button — one, Quick reply

```
Play now
```

A quick-reply button sends its text back as a normal message, which re-opens
the 24-hour window and drops the player straight into the existing flow. Do not
use a URL button here: the board link is per-player and signed, so it cannot be
baked into a template.

---

## Why these choices

**Utility, not Marketing.** Utility templates are for service updates about an
existing relationship — exactly what this is. Marketing templates cost more,
and any user who has opted out of marketing simply will not receive one, which
is the opposite of what an all-clear message is for.

**The player's name in `{{1}}`.** Templates that read like a broadcast get
reported. One that opens with a name reads like the service talking to you.

**The game name in `{{2}}`** rather than hard-coded, so a second game reuses
this template instead of needing its own approval round.

**No URL button.** Every board link is signed for one player in one game, so
there is nothing static to put in a template. The quick reply gets them back
into the conversation, and the bot sends the real link.

---

## Sending it

Once approved, the template name goes in `.env`:

```
WHATSAPP_TEMPLATE_BACK_ONLINE=platform_back_online
```

Then, from the admin panel's maintenance screen, "Notify players" sends it to
everyone who played recently. The raw Cloud API shape, for reference:

```json
{
  "messaging_product": "whatsapp",
  "to": "919886122415",
  "type": "template",
  "template": {
    "name": "platform_back_online",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Priya" },
          { "type": "text", "text": "Tambola" }
        ]
      }
    ]
  }
}
```

The quick-reply button needs no `components` entry — its text is fixed at
approval time.

### Approval

Utility templates are usually approved in minutes, occasionally a few hours.
The common rejection reasons, all avoided above: a variable with no sample, a
variable at the very start or end of the body, and promotional wording in a
Utility template.
