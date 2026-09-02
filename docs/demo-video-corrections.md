# Demo video — what no longer matches the platform

About `src/media/mastipe-demo.mp4` (English, 2:53, 1280×720) and its Hindi
counterpart. Checked frame by frame against the running code.

The video is well made and most of it is still right. Seven things have changed
since it was recorded. One of them teaches a rule the game does not have.

---

## 1. It shows the called number lighting up on the ticket — **fix first**

**Where:** roughly 1:05–2:00, wherever a number is being answered.

**What it shows:** when a number is called, that square on the player's ticket
is highlighted before they answer.

**What the platform does:** nothing. The board deliberately gives no sign that
the called number is on your ticket — finding it is the entire skill of the
game. The highlight was removed on purpose.

**Why it matters more than the rest:** a new player who learns from this video
will sit waiting for the board to point at their number, miss it, and conclude
the game is broken. Everything else on this list is cosmetic; this one teaches
the opposite of the rule.

The only marking that should ever appear is the green dauber, and only **after**
the player taps *I have it*.

## 2. "Early Five" → **Jaldi 5**

**Where:** 2:00–2:15, the first prize card.

The prize is called **Jaldi 5** everywhere in the product — WhatsApp, the board,
the reports, the admin panel.

## 3. "Four Corners" → **Corners**

**Where:** 2:30–2:45, the fourth prize card.

## 4. The answer buttons are worded differently

**Where:** every play scene.

| Video | Platform |
| --- | --- |
| `Yes, I have this number` | `✓ I have it` |
| `No, not on my ticket` | `✗ Not on mine` |

## 5. The call-out lines are no longer Hindi transliterations

**Where:** the number banner throughout — "sattaais", "chhiyalis", "chausath".

All ninety lines were rewritten in neutral English. They now read as digits
first, then the number, which is what gives a player a second chance to catch a
call:

- 27 → `Two and seven, twenty-seven.`
- 46 → `Four and six, forty-six.`
- 64 → `Six and four, sixty-four.`

## 6. It stops before the end of the game

The video finishes on the prize explanations. The product continues:

- a **game-over banner** naming the reason and the player who ended it
- a single **Provide Feedback** button leading to a rating and comment form
- the **report** link, and **Get my play history** in the Options menu

These are the parts players ask about most.

## 7. There is no Exit

Players can now leave mid-game, with a warning that they cannot rejoin, and
everyone else is told by name. Nothing in the video covers it.

---

## What was done instead of re-cutting the video

The how-to-play page now carries a **self-running walkthrough** underneath the
video (`src/http/demo-walkthrough.js`). It reads the real ticket generator, the
real prize list, the real call-out lines and the real draw interval, so it
cannot drift the way a recording does — rename a prize and the walkthrough
renames it too, with nothing to re-record.

Thirteen scenes: message the bot, fill the room, start, the countdown, marking
(with the point about no hint made explicitly), a missed number, claiming,
leaving, the ending, and the report.

The video still leads the page, because a real recording with a voice is worth
more than an animation for a first-time visitor. It just is not the only thing
explaining the rules any more.

## If the video is re-cut

Everything above, plus: the pacing line "a number every 12 seconds" comes from
`GAME_DRAW_INTERVAL_SECONDS` and can be changed per deployment, so it is safer
to say "every few seconds" than to name a number.
