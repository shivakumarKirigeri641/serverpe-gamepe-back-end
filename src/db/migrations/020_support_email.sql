-- 020_support_email.sql
-- ---------------------------------------------------------------------------
-- Support moves to support@serverpe.in.
--
-- MastiPe is a product; ServerPe App Solutions is the company that answers for
-- it. A report of abuse, a refund question or a block appeal is addressed to
-- the company, not to one of its games — and the same mailbox then serves
-- QuizPe and anything after it, rather than each product growing an address
-- nobody monitors.
--
-- The earlier seed migrations were corrected too, so a fresh database is right
-- from its first boot. This one fixes a database that has already run them:
-- the migrator tracks filenames only, so those files will never re-run here.
--
-- A plain string replacement rather than rewritten document bodies, because the
-- documents are admin-editable and may already carry local edits that must
-- survive. Only the address changes.

UPDATE business_profile
   SET support_email = 'support@serverpe.in'
 WHERE support_email = 'support@mastipe.in';

UPDATE legal_documents
   SET body    = replace(body,    'support@mastipe.in', 'support@serverpe.in'),
       body_hi = replace(body_hi, 'support@mastipe.in', 'support@serverpe.in')
 WHERE body LIKE '%support@mastipe.in%'
    OR body_hi LIKE '%support@mastipe.in%';

-- Deliberately NOT bumping `version`.
--
-- Bumping it would invalidate every player's consent and ask all of them to
-- accept again. Correcting the address we ask people to write to is not a
-- change to what they agreed, and re-consenting the whole base over a mailbox
-- rename would train them to click through the terms without reading.
