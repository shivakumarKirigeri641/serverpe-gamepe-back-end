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
    `Full policies: ${config.publicRoot}/policies\n\n` +
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

  optionsComingSoon: () =>
    `More options are on the way. 🚧\n\n` +
    `For now you can *Play Tambola* or *Join a game*. Type *hi* to go back.`,

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
