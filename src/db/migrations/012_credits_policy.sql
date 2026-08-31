-- The refund and liability documents predate credits and now contradict how
-- the product actually behaves: they warn that a fee is lost if nobody joins,
-- when in fact the host is never charged until the first number is drawn.
--
-- Wrong-in-the-customer's-favour is still wrong, and a policy that describes a
-- charge that cannot happen invites exactly the dispute it was written to
-- prevent. Versions are bumped, so everyone accepts the corrected text.

UPDATE legal_documents
   SET body = E'*Refund Policy*\n\nMastiPe is currently *free to play*. No payment is taken from you at any point.\n\nWhen paid plans begin, MastiPe works on *credits*.\n\n*1. Credits*\nYou add credits to your wallet, and a game is paid for from that balance. Credits have no cash value, cannot be withdrawn, transferred or exchanged for money, and do not expire while your account is active.\n\n*2. You are only charged when a game actually starts calling numbers.*\nCreating a room costs nothing. Pressing Start costs nothing. The plan price is taken from your wallet only when the *first number is called*.\n\n*3. If nobody joins your game.*\nNo number is ever called, so *nothing is deducted* and your credits remain in your wallet for the next game. There is nothing to refund because nothing was charged.\n\n*4. If players leave part-way through.*\nOnce the first number has been called the game has been delivered, and that game''s credits are not returned. We cannot control whether other people keep playing.\n\n*5. If we cancel a game.*\nIf a fault at our end stops a game we have charged for, those credits are returned to your wallet.\n\n*6. Money paid for credits.*\nAmounts paid to buy credits are non-refundable once the credits are in your wallet. The credits themselves remain available to you.\n\nQuestions: support@mastipe.in',
       summary = 'Credits are only spent once a game starts calling numbers.',
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'refunds';

UPDATE legal_documents
   SET body = replace(
         body,
         E'• *Any entry fee lost because no other player joined your game*, because players left part-way through, because players stopped responding, or because a room was closed for having too few players. You decide when to start a game and you accept that risk.',
         E'• Credits spent on a game that had already begun calling numbers, whatever happened next — players leaving, players not responding, or the room closing early. Credits are never taken for a game that never called a number.'
       ),
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE doc_key = 'liability';

UPDATE legal_documents
   SET body = replace(
         body,
         'If you pay to start a game, you are responsible for making sure enough people are actually ready to play.',
         'Credits are only spent once a game begins calling numbers, so a game nobody joins costs you nothing.'
       ),
       updated_at = now()
 WHERE doc_key = 'liability';
