/**
 * Every word the bot says, in one place.
 *
 * Reword anything here freely - nothing in this file affects game logic. Only
 * the button ids matter, and those live in BUTTONS below.
 */
import { config } from '../config/env.js';
import { trialEndsAt } from './settings.service.js';

/** Button ids are the contract between what we send and what comes back. */
export const BUTTONS = {
  CONSENT_AGREE: 'consent_agree',
  MENU_PLAY: 'menu_play',
  MENU_BAKRA: 'menu_bakra',
  MENU_JOIN: 'menu_join',
  MENU_OPTIONS: 'menu_options',
  PLAN_FREE_TRIAL: 'plan_free_trial',
};

const brand = () => config.brandName;

/** A time a player can act on - "2 Sep, 9:30 pm" rather than an ISO string. */
function formatTime(iso) {
  if (!iso) return 'shortly';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
      timeZone: config.timezone,
    });
  } catch {
    return 'shortly';
  }
}

function trialEndsOn() {
  try {
    return new Date(trialEndsAt()).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone,
    });
  } catch {
    return trialEndsAt();
  }
}

export const copy = {
  greeting: () =>
    `Namaste! Welcome to *${brand()}* 🎉\n\n` +
    `Tambola on WhatsApp - grab your friends, grab a ticket, and let's play.\n\n` +
    `Before we start, please read and accept our terms.`,

  consent: () =>
    `*Terms, Privacy & Fair Play*\n\n` +
    `• ${brand()} is for entertainment. No real-money gambling.\n` +
    `• We store your WhatsApp number, your tickets and your game history to run the game.\n` +
    `• When you open your game board we also record your device and IP, to keep games fair.\n` +
    `• We never sell your data or message you outside a game.\n` +
    `• Play fair. Abuse or cheating means removal.\n\n` +
    `Full policies: ${config.policiesUrl}\n\n` +
    `Tap below to accept and continue.`,

  consentDone: () => `Thank you! You're all set. 🎫`,

  menu: () => `What would you like to do?`,

  askPlayerCount: (min, max) =>
    `How many players will be joining, including you?\n\n` +
    `Reply with a number between *${min}* and *${max}*.\n\n` +
    `_Example: 8_`,

  badPlayerCount: (min, max, got) =>
    `"${got}" doesn't look like a valid number of players.\n\n` +
    `Please reply with a number between *${min}* and *${max}*.`,

  planCard: (playerCount) =>
    `*Tambola* for *${playerCount}* players 🎲\n\n` +
    `• 6 prizes: Jaldi 5, Top Line, Middle Line, Bottom Line, Corners, Full House\n` +
    `• One number every ${config.game.drawIntervalSeconds} seconds\n` +
    `• Everyone plays in their browser, no app to install\n\n` +
    `*Free Trial* - unlimited games, no charge, until ${trialEndsOn()}.\n\n` +
    `Tap below to create your game room.`,

  /**
   * The invite link is deliberately NOT in this message.
   *
   * It used to be, and it appeared twice: once here as raw text, and again in
   * the game room with a Copy button beside it. The raw one was the worse of
   * the two — a long wa.me URL wrapping across a chat bubble, easy to
   * half-select when copying, and sitting above the button the host needs to
   * press anyway. One link, in one place, with one tap to copy it.
   */
  gameCreated: (code) =>
    `Your game room is ready! 🎉\n\n` +
    `*Game code: ${code}*\n\n` +
    `Open your game room below. The link to share with your players is waiting ` +
    `inside, with a button to copy it — paste that into your WhatsApp group and ` +
    `they're in.`,

  askJoinCode: () =>
    `What's the game code?\n\n` +
    `It's 6 characters, like *${'ABC123'}*. Your host will have shared it.`,

  badJoinCode: (got) =>
    `"${got}" doesn't look like a game code.\n\n` +
    `Game codes are 6 letters and numbers, like *ABC123*. Please try again.`,

  joined: (code, hostName) =>
    `You're in! 🎫\n\n` +
    `*Game ${code}*${hostName ? `, hosted by ${hostName}` : ''}\n\n` +
    `Your ticket is ready. Open the game room below and wait for the host to start.`,

  alreadyJoined: (code) =>
    `You're already in game *${code}*. Open your game room below.`,

  joinFailed: (reason) => `Sorry - ${reason}.\n\nType *hi* to start again.`,

  /**
   * They tapped into a game that has already finished, and they were in it.
   *
   * Not an error - they did nothing wrong, and their game genuinely happened.
   * So this says what became of it and hands them the one thing still worth
   * having: their own report.
   */
  gameAlreadyOver: (code, endedReason) => {
    const how =
      endedReason === 'full_house' ? 'Someone completed their full ticket.'
        : endedReason === 'abandoned' ? 'It ended early - too few players were left to carry on.'
          : 'All 90 numbers were called.';
    return (
      `*Game ${code} is over.*\n\n${how}\n\n` +
      `Your report is still here — your ticket, every number called, and how you marked it.`
    );
  },

  /** Over, and they were never in it. Nothing to show, so point them onward. */
  gameOverNotYours: (code) =>
    `*Game ${code} has already finished*, so there's nothing to join.\n\n` +
    `Type *hi* to start a game of your own.`,

  alreadyInGame: (code) =>
    `You're already in game *${code}*.\n\n` +
    `Finish or leave that one before starting another. Open it below.`,

  optionsMenu: () => `What would you like?`,

  /** Nothing to report yet - said without making them feel they missed a step. */
  noRecentGame: () =>
    `You haven't finished a game yet, so there's no report to show.\n\n` +
    `Play one and we'll send you a full report the moment it ends — your ticket, ` +
    `every number called, and how you did.\n\n` +
    `Type *hi* to start.`,

  recentReport: (code, when, url) =>
    `Your most recent game: *${code}*\n_${when}_\n\n` +
    `Ticket, every number called, your taps and how accurate you were:\n${url}\n\n` +
    `Open it and tap *Save as PDF* to keep a copy.`,

  /** They asked for their history before playing anything. */
  noHistoryYet: () =>
    `You have not played a game yet, so there is no history to show.

` +
    `Play one and this fills in by itself - every game, your accuracy, and how ` +
    `you are improving.

Type *hi* to start.`,

  playHistory: (games) =>
    `*Your play history* 📊

` +
    `All ${games} game${games === 1 ? '' : 's'} you have played, in one page: every game with ` +
    `dates and results, your accuracy over time, prizes won, how you compare with the ` +
    `people you play with, and what to work on.

` +
    `Open it and tap *Save as PDF* to keep a copy.`,

  demoIntro: () =>
    `Here's how ${brand()} works — a short video, plus a real ticket with numbers ` +
    `being called.`,

  /**
   * Suggested to people about to play for the first time.
   *
   * Worth the extra lines because the two mistakes a first-timer makes are
   * both expensive and both preventable in sixty seconds: they do not realise
   * a number they miss is gone, and they do not realise a prize has to be
   * claimed rather than being awarded automatically.
   *
   * A recommendation, not a gate. They can ignore it and start playing, and
   * anyone who has played before never sees it at all - a tip that repeats
   * forever stops reading as advice and starts reading as noise.
   */
  demoTip: (url) =>
    `\n\n💡 *First time? Watch the short demo first:*\n${url}\n` +
    `It shows how to mark your ticket and how to claim a prize — worth it ` +
    `before the numbers start.`,

  /** Not on sale yet. Said plainly rather than dressed up as a teaser. */
  sponsorPlaceholder: () =>
    `*Sponsor a parent* 💛\n\n` +
    `Soon you'll be able to sponsor a parent's daily revision quiz on ` +
    `*${config.sponsorship.partner}* for ₹${Math.round(config.sponsorship.pricePaise / 100)} — ` +
    `and get ${config.sponsorship.complimentaryHours} hours of unlimited ${brand()} games, complimentary.\n\n` +
    `The clock would start when your first game does, not when you pay.\n\n` +
    `It isn't live yet. Everything is free while the trial runs, so there's ` +
    `nothing to buy today.\n\n` +
    `Type *hi* to play.`,

  feedbackIntro: () =>
    `We'd love to know what you think. It takes about twenty seconds.`,

  supportIntro: () =>
    `Happy to help. Tell us what's up and we'll reply right here on WhatsApp.`,

  ticketStatus: (ticket, messages) => {
    const labels = {
      open: 'Open — we have it and will look shortly',
      in_progress: 'Being looked at now 🔎',
      waiting_on_player: 'Waiting for your reply',
      resolved: 'Resolved ✅',
      closed: 'Closed',
    };
    const last = messages.filter((m) => m.author !== 'player').slice(-1)[0];
    return (
      `*${ticket.reference}*\n${ticket.subject}\n\n` +
      `Status: *${labels[ticket.status] ?? ticket.status}*\n` +
      (last ? `\nLast from us:\n_${last.body.split('\n')[0].slice(0, 200)}_\n` : '') +
      `\nReply here any time to add to it.`
    );
  },

  noSuchTicket: (reference) =>
    `We can't find a ticket with reference *${reference}*.\n\n` +
    `Check the code, or send *support* to raise a new one.`,

  unknown: () =>
    `Sorry, I didn't understand that.\n\n` +
    `Type *hi* to see the menu.`,

  /** After a star is tapped. The comment is invited, never demanded. */
  ratingThanks: (rating) =>
    (rating >= 4
      ? `Wonderful — thank you! 🌟\n\n`
      : rating >= 3
        ? `Thanks for the honest rating. 🙏\n\n`
        : `Sorry it missed the mark — thank you for saying so. 🙏\n\n`) +
    `Anything you'd like to add? Just type it and send.\n\n` +
    `_Or reply *skip* if you'd rather not._`,

  feedbackDone: (hadComment) =>
    (hadComment ? `Thank you — noted. 💛\n\n` : `No problem at all. 💛\n\n`) +
    `Type *hi* whenever you want another game.`,

  /**
   * The only thing the bot says during planned downtime.
   *
   * Says what is happening, when it ends, and that nothing was lost - the
   * three things someone who just messaged an unresponsive service wants to
   * know. An operator's own wording replaces the middle line if they set one.
   */
  maintenance: (window) => {
    const back = window.endsInMinutes != null
      ? (window.endsInMinutes > 90
          ? `We expect to be back by ${formatTime(window.to)}.`
          : `We expect to be back in about ${window.endsInMinutes} minute${window.endsInMinutes === 1 ? '' : 's'}.`)
      : window.to
        ? `We expect to be back by ${formatTime(window.to)}.`
        : `We will be back shortly.`;

    return (
      `🔧 *${brand()} is down for scheduled maintenance*\n\n` +
      (window.message ? `${window.message}\n\n` : '') +
      `${back}\n\n` +
      `Nothing you have played is lost. Message *hi* once we are back and ` +
      `everything will be exactly where you left it.\n\n` +
      `Sorry for the interruption.`
    );
  },

  notInAGame: () =>
    `You are not in a game right now.\n\nType *hi* to start one.`,

  /** What the leaver themselves is told. Never celebratory. */
  youLeft: (code, aborted) =>
    `You have left game *${code}*.\n\n` +
    (aborted
      ? `That left too few players to carry on, so the game has ended for everyone. ` +
        `No prizes were awarded.\n\n`
      : `The others are still playing.\n\n`) +
    `Type *hi* whenever you would like another game.`,

  /** Sent with the end-of-game summary. */
  gameReport: (code, url) =>
    `Your full report for game *${code}* — your ticket, every number called, ` +
    `and how you marked it:\n${url}`,

  hostStartWarning: () =>
    `Once you start, ${brand()} takes over as host and you become a regular player. ` +
    `No one else can join after that.`,
};

/**
 * The main menu: both games, then everything else.
 *
 * WhatsApp allows three reply buttons, and a menu step in front of them would
 * cost every returning player a tap forever to solve a problem that only
 * exists once. So the two games are always visible and never behind anything -
 * and there is no hamburger, because WhatsApp has no such thing: a list
 * message renders a button carrying words we choose.
 *
 * "Join game" moved into More. Players normally arrive through the host's
 * shared link rather than by typing a code, so it does not deserve one of the
 * three slots that a game does.
 */
export const menuButtons = () => [
  { id: BUTTONS.MENU_PLAY, title: 'Tambola' },
  { id: BUTTONS.MENU_BAKRA, title: 'Tap Bakra' },
  { id: BUTTONS.MENU_OPTIONS, title: 'More' },
];

export const consentButtons = () => [
  { id: BUTTONS.CONSENT_AGREE, title: 'Agree & continue' },
];

export const planButtons = () => [
  { id: BUTTONS.PLAN_FREE_TRIAL, title: 'Free trial' },
];

/**
 * The Options menu.
 *
 * A LIST, not buttons: WhatsApp caps reply buttons at three and there are five
 * choices here. A list also gives each row a description, which is where the
 * "what does this actually do" explanation belongs.
 */
export const OPTIONS = {
  JOIN: 'opt_join',
  REPORT: 'opt_report',
  HISTORY: 'opt_history',
  DEMO: 'opt_demo',
  SPONSOR: 'opt_sponsor',
  FEEDBACK: 'opt_feedback',
  SUPPORT: 'opt_support',
};

export const optionsList = () => ({
  // The button carries words, not an icon. WhatsApp has no hamburger and this
  // is the only label a player sees before opening the list.
  buttonText: 'See all options',
  header: config.brandName,
  footer: 'Tap an option to continue',

  /*
   * Grouped by what somebody is trying to do, not by which game.
   *
   * Only one row below belongs to a single game - joining needs a room code,
   * and only Tambola has rooms. Everything else already spans both, so a
   * section per game would be one row, then nothing, then a bigger leftover
   * pile than before.
   *
   * WhatsApp allows ten rows across all sections; seven leaves room for a
   * third game without a redesign.
   */
  sections: [
    {
      title: 'Your play',
      rows: [
        { id: OPTIONS.REPORT, title: 'Recently played', description: 'Your last report, from either game' },
        { id: OPTIONS.HISTORY, title: 'My play history', description: 'Everything you have played, both games' },
      ],
    },
    {
      title: 'Tambola',
      rows: [
        { id: OPTIONS.JOIN, title: 'Join a game', description: 'Have a room code from a friend? Enter it here' },
      ],
    },
    {
      title: 'Help & more',
      rows: [
        { id: OPTIONS.DEMO, title: 'How to play', description: 'Both games, explained in a minute' },
        { id: OPTIONS.SPONSOR, title: 'Sponsor a parent', description: `Support a parent on ${config.sponsorship.partner}` },
        { id: OPTIONS.FEEDBACK, title: 'Give feedback', description: 'Rate a game and tell us what you think' },
        { id: OPTIONS.SUPPORT, title: 'Support', description: 'Raise a question and get a reference' },
      ],
    },
  ],
});

/** Appended to `copy` after definition to keep the main object readable. */
copy.replyAdded = (reference) =>
  `Added to your support request *${reference}*. 📝\n\n` +
  `We will get back to you here. Send *status ${reference}* any time to check on it.`;

/**
 * Tap Bakra's invitation.
 *
 * Deliberately short. The game explains itself in one screen, and a paragraph
 * of rules in WhatsApp is a paragraph nobody reads before tapping the link.
 */
export const bakra = {
  intro: () =>
    `*Tap Bakra* — tap fast, don't be the bakra.\n\n` +
    `10 questions. 5 seconds each. Sometimes the right answer is to tap nothing at all.\n\n` +
    `Your link is below. It is yours alone.`,

  linkText: () => 'Play Tap Bakra',
};


/**
 * Answers that have to cover two games at once.
 *
 * Written as one message with both links rather than a "which game?" question,
 * because a menu that answers a menu is how a bot starts feeling like paperwork.
 */
export const bothGames = {
  /**
   * Both games, side by side.
   *
   * The counts come first because they are the answer: somebody asking for
   * their history wants to know how much there is before they open anything.
   */
  historyBoth: ({ games, rounds, tambolaUrl, bakraUrl }) => {
    const lines = ['*Your play history*', ''];

    lines.push(games
      ? `🎟️ *Tambola* — ${games} game${games === 1 ? '' : 's'}`
      : '🎟️ *Tambola* — nothing yet');
    if (games && tambolaUrl) lines.push(tambolaUrl);

    lines.push('');
    lines.push(rounds
      ? `🐐 *Tap Bakra* — ${rounds} round${rounds === 1 ? '' : 's'}`
      : '🐐 *Tap Bakra* — nothing yet');
    if (rounds && bakraUrl) lines.push(bakraUrl);

    lines.push('', 'Each page opens in your browser. Tap *Save as PDF* to keep a copy.');
    return lines.join('\n');
  },

  /** The other game, offered once, after the answer they asked for. */
  alsoPlayed: (game, when, url) =>
    `\n\nYour last *${game}` + `* was ${when}:\n${url}`,

  history: (tambolaGames, bakraRounds) => {
    const lines = ['*Your play history*', ''];
    lines.push(tambolaGames
      ? `• Tambola — ${tambolaGames} game${tambolaGames === 1 ? '' : 's'}`
      : '• Tambola — nothing yet');
    lines.push(bakraRounds
      ? `• Tap Bakra — ${bakraRounds} round${bakraRounds === 1 ? '' : 's'}`
      : '• Tap Bakra — nothing yet');
    lines.push('', 'The links below open each one.');
    return lines.join('\n');
  },

  nothingPlayed: () =>
    'You have not finished a game yet.\n\n' +
    'Start a Tambola game with your group, or play a minute of Tap Bakra on your own — ' +
    'both are on the menu.',

  howToPlay: () =>
    '*How to play*\n\n' +
    '*Tambola* — the host starts a room and shares one link. ' +
    'Numbers are called automatically and you tap the ones on your ticket. ' +
    'Six prizes, up to 200 players.\n\n' +
    '*Tap Bakra* — ten instructions, five seconds each. ' +
    'Tap the right one before the clock runs out. ' +
    'Sometimes the instruction says *not* to tap, and that is where most people slip.\n\n' +
    'The video below walks through a real Tambola ticket.',

  recentBakra: (score, correct, of, when) =>
    `*Tap Bakra* — your last round\n\n` +
    `• Score: ${score}\n• Correct: ${correct} of ${of}\n• Played: ${when}\n\n` +
    'The full report is below.',
};
