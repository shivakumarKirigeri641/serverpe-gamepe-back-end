-- 021_support_email_revert.sql
-- ---------------------------------------------------------------------------
-- Support goes back to support@mastipe.in.
--
-- 020 moved it to support@serverpe.in on the reasoning that the company answers
-- for the product. That reasoning was fine and the fact was wrong: the mailbox
-- that actually exists is support@mastipe.in. A policy that tells people to
-- write to an address nobody receives is worse than no address at all — a
-- refund question or an abuse report would simply bounce.
--
-- 020 is left in place rather than deleted, so the history of what the database
-- was told stays readable. On a fresh database the pair cancel out; on this one
-- this file undoes the change.
--
-- As in 020, `version` is deliberately not bumped: correcting an address is not
-- a change to what players agreed to, and re-consenting everyone over a mailbox
-- would teach them to click past the terms.

UPDATE business_profile
   SET support_email = 'support@mastipe.in'
 WHERE support_email = 'support@serverpe.in';

UPDATE legal_documents
   SET body    = replace(body,    'support@serverpe.in', 'support@mastipe.in'),
       body_hi = replace(body_hi, 'support@serverpe.in', 'support@mastipe.in')
 WHERE body LIKE '%support@serverpe.in%'
    OR body_hi LIKE '%support@serverpe.in%';
