-- Adds the "nobody joined / everybody left" clause to the refund and liability
-- documents, ahead of entry fees being switched on.
--
-- The version is bumped, which invalidates existing consent and asks every
-- player to accept again — correct, because this changes what they are
-- agreeing to. Edit the wording from the admin panel; this is only the default.

UPDATE legal_documents
   SET body = E'*Refund Policy*\n\nMastiPe is currently *free to play*. No payment is taken from you at any point, and no money changes hands.\n\nBecause no payment is collected, *there is nothing to refund and no refunds are available.*\n\nIf a paid feature is introduced in future, the following will apply.\n\n*1. Entry fees are non-refundable once a game starts.*\nWhen the host starts a game, the entry fee has been used to run that game. It is not refundable, whatever happens next.\n\n*2. If nobody joins your game.*\nIf you create and pay for a game and no other player joins, *the fee is not refunded.* You choose when to start; you can wait as long as you like for players to arrive, or leave the room without starting it. A room that is never started is never charged.\n\n*3. If players leave part-way through.*\nIf other players leave mid-game, or stop responding, or the room is closed because too few players remain, *the fee is not refunded.* We cannot control whether other people keep playing.\n\n*4. What we do refund.*\nIf *we* cancel a game before it starts — for a technical fault at our end — any fee paid is returned to your wallet balance.\n\n*5. Wallet balances.*\nWallet balances have no cash value, cannot be withdrawn, transferred or exchanged for money.\n\n*ServerPe App Solutions is not responsible for money lost because no player joined your game, because players left part-way through, or because you or others chose to exit.* Please only pay an entry fee when you are confident your friends will actually play.\n\nYou will be asked to accept an updated policy before any charge is ever made.\n\nQuestions: admin@serverpe.in',
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'refunds';

UPDATE legal_documents
   SET body = E'*Limitation of Liability*\n\nPlease read this carefully. It limits what *ServerPe App Solutions* is responsible for.\n\n*We are not responsible for:*\n• Any loss arising from the service being unavailable, delayed, interrupted or cancelled.\n• Messages that WhatsApp fails to deliver, delivers late, or delivers out of order.\n• A game result you disagree with, once decided by our servers.\n• *Any entry fee lost because no other player joined your game*, because players left part-way through, because players stopped responding, or because a room was closed for having too few players. You decide when to start a game and you accept that risk.\n• Any money, goods, favours or bets that players arrange between themselves. Such arrangements are not part of this service, are not endorsed by us, and are entirely at the participants'' own risk.\n• Any unlawful act committed by a player using this service.\n• Anything that happens outside this service, including on other apps, groups or websites.\n• Loss of data, loss of points, loss of a leaderboard position, or loss of an opportunity to win.\n\n*Your responsibility*\nYou are responsible for how you use this service and for obeying the laws that apply to you. If your use of the service is unlawful where you live, you must stop using it. If you pay to start a game, you are responsible for making sure enough people are actually ready to play.\n\n*To the fullest extent permitted by law*, the service is provided without warranties of any kind, and our total liability to you for any claim connected with the service is limited to the amount you have paid us in the twelve months before the claim — which, while the service is free, is zero.\n\nNothing in this policy limits liability that cannot lawfully be limited, including for death or personal injury caused by negligence, or for fraud.\n\nOperated by *ServerPe App Solutions*. Contact: admin@serverpe.in',
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'liability';

UPDATE legal_documents
   SET summary = 'Free to play. No refunds — including if nobody joins your game.'
 WHERE doc_key = 'refunds';
