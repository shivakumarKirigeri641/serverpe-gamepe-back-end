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

  gameCreated: (code, invite) =>
    `Your game room is ready! 🎉\n\n` +
    `*Game code: ${code}*\n\n` +
    `Share this link with your players:\n${invite}\n\n` +
    `They tap it, accept the terms, and they're in. ` +
    `Open your host screen below to watch them arrive and start the game.`,

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

  demoIntro: () =>
    `Here's how ${brand()} works — a real ticket, with numbers being called. ` +
    `Takes about a minute.`,

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

/** The three-button main menu. */
export const menuButtons = () => [
  { id: BUTTONS.MENU_PLAY, title: 'Play Tambola' },
  { id: BUTTONS.MENU_JOIN, title: 'Join game' },
  { id: BUTTONS.MENU_OPTIONS, title: 'Options' },
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
  REPORT: 'opt_report',
  DEMO: 'opt_demo',
  SPONSOR: 'opt_sponsor',
  FEEDBACK: 'opt_feedback',
  SUPPORT: 'opt_support',
};

export const optionsList = () => ({
  buttonText: 'View options',
  header: config.brandName,
  footer: 'Tap an option to continue',
  sections: [{
    title: 'Options',
    rows: [
      { id: OPTIONS.REPORT, title: 'Recently played', description: 'Your last game report, ready to download' },
      { id: OPTIONS.DEMO, title: 'How to play', description: 'A short walkthrough with a real ticket' },
      { id: OPTIONS.SPONSOR, title: 'Sponsor a parent', description: `Support a parent on ${config.sponsorship.partner}` },
      { id: OPTIONS.FEEDBACK, title: 'Give feedback', description: 'Rate a game and tell us what you think' },
      { id: OPTIONS.SUPPORT, title: 'Support', description: 'Raise a question and get a reference' },
    ],
  }],
});

/** Appended to `copy` after definition to keep the main object readable. */
copy.replyAdded = (reference) =>
  `Added to your support request *${reference}*. 📝\n\n` +
  `We will get back to you here. Send *status ${reference}* any time to check on it.`;
