-- Tells players how to report abuse and what happens when they do.
--
-- Two things a policy has to do to be worth having: name the address, and say
-- the consequence. "Contact us" with no address and no outcome is decoration.

UPDATE legal_documents
   SET body = E'*Terms & Conditions*\n\nBy using MastiPe you agree to these terms.\n\n*1. Who may use this service*\nYou must be at least 18 years old, or the age of majority where you live, and legally able to enter into these terms.\n\n*2. Your account*\nYour WhatsApp number identifies you. You are responsible for everything done through your number. Do not let others play as you.\n\n*3. Acceptable use*\nYou agree not to: cheat or exploit faults in the game; use bots, scripts or automation; create multiple accounts to obtain free games or promotional credits more than once; harass, abuse, threaten or impersonate other players or us; send obscene, hateful or unlawful content; attempt to disrupt, overload or gain unauthorised access to the service; resell or commercialise access; or use the service for betting, wagering or any other unlawful purpose.\n\n*4. Reporting someone*\nIf another player harasses you, cheats, or tries to use a game for betting or anything unlawful, *report it to support@mastipe.in*.\n\nInclude:\n• the mobile number of the person you are reporting\n• the room code, if it happened in a game\n• what happened, and roughly when\n\nWe read every report. Where we find a breach we may *block that mobile number from MastiPe permanently*, and blocked numbers cannot start or join any game. Please do not confront the person yourself.\n\n*5. Blocking*\nWe may block a number that breaches these terms. A blocked number is told once that it has been blocked and how to appeal. To appeal, write to *support@mastipe.in* from the number in question, and we will review it.\n\n*6. Fair play*\nGame results are decided by our servers and are final. Numbers are drawn from a random sequence fixed at the start of each round. If we find evidence of cheating or abuse we may void a result, remove you from a game, withdraw free games or promotional credits, or block you permanently.\n\n*7. Suspension and closure*\nWhere an account is closed for a serious breach, unused *promotional* credits and free games are forfeited. Credits you have *paid for* are not forfeited; write to us and we will discuss them with you.\n\n*8. Availability*\nThe service is provided on an "as is" and "as available" basis. It may be interrupted, delayed or withdrawn at any time. Games may be cancelled for technical reasons.\n\n*9. Messaging*\nWe communicate with you on WhatsApp. Message and data charges from your mobile provider are your responsibility. You can stop at any time by sending *STOP*.\n\n*10. Changes to these terms*\nWe may update these terms. If we do, you will be asked to accept the new version before your next game.\n\n*11. Governing law*\nThese terms are governed by the laws of India, and the courts of Bengaluru, Karnataka have exclusive jurisdiction.\n\nOperated by *ServerPe App Solutions*. Contact: support@mastipe.in',
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'terms';

UPDATE legal_documents
   SET body = E'*Entertainment Only*\n\nMastiPe is a game played for entertainment. By continuing you confirm that you understand and accept the following.\n\n• There is *no betting, gambling or wagering* of any kind on this service.\n• *No money is involved.* You are not asked to pay to play, and you cannot win money.\n• Points, badges and leaderboard positions have *no monetary value*, cannot be exchanged for cash or goods, and cannot be transferred or sold.\n• Nothing on this service is a lottery, a prize competition, or a game of chance played for stakes.\n• You must not use this service to organise, promote or settle any bet, wager or money game between players. Doing so is a breach of these terms and may be unlawful.\n\n*ServerPe App Solutions* (operator of MastiPe) is *not responsible* for any arrangement, transaction, bet or dispute that players make between themselves outside this service. Any such activity is entirely at your own risk and is not endorsed, facilitated, monitored or supported by us.\n\n*If you see it happening, report it.*\nIf you believe someone is using MastiPe for betting, or for any other unlawful purpose, stop playing with them and report it to *support@mastipe.in* with their mobile number and the room code. We may block that number from MastiPe permanently.',
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'entertainment_only';

UPDATE legal_documents
   SET body = replace(
         body,
         'Write to admin@serverpe.in and we will respond within 30 days.',
         'Write to support@mastipe.in and we will respond within 30 days.'
       ),
       updated_at = now()
 WHERE doc_key = 'privacy';

-- The old contact address appears in several documents; make them consistent.
UPDATE legal_documents
   SET body = replace(body, 'admin@serverpe.in', 'support@mastipe.in'),
       updated_at = now()
 WHERE body LIKE '%admin@serverpe.in%';
