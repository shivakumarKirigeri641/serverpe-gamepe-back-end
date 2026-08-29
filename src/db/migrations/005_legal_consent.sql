-- Player-facing legal documents and the record of who accepted what.
--
-- Content lives in the database, not in code, so it is editable from the admin
-- panel without a deploy. `version` is the mechanism that forces re-consent:
-- bump it and every player is asked again before their next game.

CREATE TABLE IF NOT EXISTS legal_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_key          text NOT NULL UNIQUE,
  -- Shown as the row title in a WhatsApp list: 24 characters hard limit.
  title            text NOT NULL,
  -- Shown as the row description: 72 characters hard limit.
  summary          text NOT NULL,
  -- The full text, sent when a player opens the document.
  body             text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  display_order    integer NOT NULL DEFAULT 0,
  -- false for informational documents that do not gate play.
  requires_consent boolean NOT NULL DEFAULT true,
  is_active        boolean NOT NULL DEFAULT true,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_documents_title_len CHECK (char_length(title) <= 24),
  CONSTRAINT legal_documents_summary_len CHECK (char_length(summary) <= 72),
  CONSTRAINT legal_documents_version_positive CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS legal_documents_active_idx
  ON legal_documents(display_order) WHERE is_active;

-- Append-only proof of acceptance. One row per player, document and version, so
-- the history survives a later version bump and can answer "what exactly did
-- this person agree to, and when".
CREATE TABLE IF NOT EXISTS player_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES legal_documents(id) ON DELETE SET NULL,
  doc_key       text NOT NULL,
  version       integer NOT NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  -- 'whatsapp' (button), 'flow' (checkbox), 'admin' (recorded manually)
  source        text NOT NULL DEFAULT 'whatsapp',
  wa_message_id text,
  request_ip    inet,
  user_agent    text,
  UNIQUE (player_id, doc_key, version)
);

CREATE INDEX IF NOT EXISTS player_consents_player_idx ON player_consents(player_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS player_consents_doc_idx ON player_consents(doc_key, version);

-- Seed content. These are starting points written to be clear to a player, NOT
-- reviewed by a lawyer — edit them from the admin panel before real users
-- arrive, and bump the version when you do.
INSERT INTO legal_documents (doc_key, title, summary, body, display_order, requires_consent)
VALUES
(
  'entertainment_only',
  'Entertainment Only',
  'No betting, no money, no prizes with cash value. Purely for fun.',
  E'*Entertainment Only*\n\nMastiPe is a game played for entertainment. By continuing you confirm that you understand and accept the following.\n\n• There is *no betting, gambling or wagering* of any kind on this service.\n• *No money is involved.* You are not asked to pay to play, and you cannot win money.\n• Points, badges and leaderboard positions have *no monetary value*, cannot be exchanged for cash or goods, and cannot be transferred or sold.\n• Nothing on this service is a lottery, a prize competition, or a game of chance played for stakes.\n• You must not use this service to organise, promote or settle any bet, wager or money game between players. Doing so is a breach of these terms and may be unlawful.\n\n*ServerPe App Solutions* (operator of MastiPe) is *not responsible* for any arrangement, transaction, bet or dispute that players make between themselves outside this service. Any such activity is entirely at your own risk and is not endorsed, facilitated, monitored or supported by us.\n\nIf you believe this service is being used for gambling or any other unlawful purpose, stop using it and report it to us immediately.',
  1,
  true
),
(
  'terms',
  'Terms & Conditions',
  'The rules for using MastiPe, and what we expect from players.',
  E'*Terms & Conditions*\n\nBy using MastiPe you agree to these terms.\n\n*1. Who may use this service*\nYou must be at least 18 years old, or the age of majority where you live, and legally able to enter into these terms.\n\n*2. Your account*\nYour WhatsApp number identifies you. You are responsible for everything done through your number. Do not let others play as you.\n\n*3. Acceptable use*\nYou agree not to: cheat or exploit faults in the game; use bots, scripts or automation; harass, abuse or impersonate other players or us; attempt to disrupt, overload or gain unauthorised access to the service; or use the service for anything unlawful.\n\n*4. Fair play*\nGame results are decided by our servers and are final. Numbers are drawn using a random sequence fixed at the start of each round. If we find evidence of cheating we may void a result, remove you from a game, or block you permanently.\n\n*5. Availability*\nThe service is provided on an "as is" and "as available" basis. It may be interrupted, delayed or withdrawn at any time, with or without notice. Games may be cancelled for technical reasons.\n\n*6. Messaging*\nWe communicate with you on WhatsApp. Message and data charges from your mobile provider are your responsibility. You can stop at any time by sending *STOP*.\n\n*7. Changes*\nWe may update these terms. If we do, you will be asked to accept the new version before your next game.\n\n*8. Ending your use*\nYou may stop using the service at any time. We may suspend or end your access if you breach these terms.\n\n*9. Governing law*\nThese terms are governed by the laws of India, and the courts of Bengaluru, Karnataka have exclusive jurisdiction.\n\nOperated by *ServerPe App Solutions*. Contact: admin@serverpe.in',
  2,
  true
),
(
  'privacy',
  'Privacy Policy',
  'What we store about you, why we store it, and your rights.',
  E'*Privacy Policy*\n\n*What we collect*\n• Your WhatsApp number and WhatsApp profile name.\n• The messages you exchange with this service, and which buttons you tap.\n• Your game activity: tickets issued, numbers you responded to, response times, claims and results.\n• Technical delivery information from WhatsApp, such as whether a message was delivered or read.\n\n*What we do NOT collect*\nWe do not receive your device details, your location, your IP address, your contacts, or any message you send to anyone other than this service. WhatsApp does not make that information available to us.\n\n*Why we collect it*\nTo run the game, to show you your ticket and results, to keep leaderboards, to detect cheating and abuse, and to improve the service.\n\n*How long we keep it*\nMessage contents are retained for 30 days and then archived. Game records and account details are kept while your account is active.\n\n*Who we share it with*\nNobody, except: WhatsApp (Meta), which carries the messages; and where we are required to by law. We do not sell your data or use it for advertising.\n\n*Your rights*\nYou may ask us what we hold about you, ask us to correct it, or ask us to delete your account and data. Write to admin@serverpe.in and we will respond within 30 days.\n\n*Security*\nWe protect your data with access controls and encrypted connections. No system is perfectly secure, and we cannot guarantee absolute security.\n\nData controller: *ServerPe App Solutions*. Contact: admin@serverpe.in',
  3,
  true
),
(
  'refunds',
  'Refund Policy',
  'The service is free to play. No payments, and therefore no refunds.',
  E'*Refund Policy*\n\nMastiPe is currently *free to play*. No payment is taken from you at any point, and no money changes hands.\n\nBecause no payment is collected, *there is nothing to refund and no refunds are available.*\n\nIf a paid feature is introduced in future:\n• You will be told the price clearly before you are charged.\n• Any amount paid is *non-refundable* once a game has begun.\n• Fees for a game that we cancel before it starts will be returned to your wallet balance.\n• Wallet balances have no cash value and cannot be withdrawn.\n\nYou will be asked to accept an updated policy before any charge is ever made.\n\nQuestions: admin@serverpe.in',
  4,
  true
),
(
  'liability',
  'Liability',
  'What we are and are not responsible for. Please read carefully.',
  E'*Limitation of Liability*\n\nPlease read this carefully. It limits what *ServerPe App Solutions* is responsible for.\n\n*We are not responsible for:*\n• Any loss arising from the service being unavailable, delayed, interrupted or cancelled.\n• Messages that WhatsApp fails to deliver, delivers late, or delivers out of order.\n• A game result you disagree with, once decided by our servers.\n• Any money, goods, favours or bets that players arrange between themselves. Such arrangements are not part of this service, are not endorsed by us, and are entirely at the participants'' own risk.\n• Any unlawful act committed by a player using this service.\n• Anything that happens outside this service, including on other apps, groups or websites.\n• Loss of data, loss of points, loss of a leaderboard position, or loss of an opportunity to win.\n\n*Your responsibility*\nYou are responsible for how you use this service and for obeying the laws that apply to you. If your use of the service is unlawful where you live, you must stop using it.\n\n*To the fullest extent permitted by law*, the service is provided without warranties of any kind, and our total liability to you for any claim connected with the service is limited to the amount you have paid us in the twelve months before the claim — which, while the service is free, is zero.\n\nNothing in this policy limits liability that cannot lawfully be limited, including for death or personal injury caused by negligence, or for fraud.\n\nOperated by *ServerPe App Solutions*. Contact: admin@serverpe.in',
  5,
  true
)
ON CONFLICT (doc_key) DO NOTHING;
