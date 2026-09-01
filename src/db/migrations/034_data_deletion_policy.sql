-- A data deletion policy, and a named grievance officer.
--
-- Both are required of an Indian consumer service and both are asked for by
-- the platforms we depend on: Meta requires a data deletion route before a
-- WhatsApp Business app goes live, and the IT Rules 2021 require a grievance
-- officer to be named with a working contact. Neither is boilerplate here —
-- the process described is the one we actually run: a request by email from
-- the registered number's owner, verified, then carried out.
--
-- requires_consent is false: this document tells a player what they can ask
-- for, it is not a term they must accept before playing. Making it a consent
-- gate would add a tap to onboarding for no benefit to anybody.

INSERT INTO legal_documents
  (doc_key, title, summary, body, title_hi, summary_hi, body_hi,
   version, display_order, requires_consent, is_active)
VALUES (
  'data_deletion',
  'Deleting your data',
  'How to have your account and everything on it removed.',
  E'You can have your MastiPe account and the data attached to it deleted at any time. You do not have to give a reason.

*How to ask*

• Write to support@mastipe.in from your own email, and include the WhatsApp number you play on.
• Or message us on WhatsApp from that number and say you want your data deleted.

*What happens next*

• We check that the request really comes from the owner of that number. This is the step that protects you: without it, anyone who knew your number could erase your account.
• Once verified, we delete your profile, your display name, your game history, your tickets, your messages and your wallet balance within 30 days.
• Any unused credits are forfeited on deletion. If you want a refund instead, ask for that first — see Payments & Refunds.

*What we keep, and why*

• Tax invoices and the payment records behind them. Indian law requires us to retain these, and we cannot delete them on request.
• Anonymised counts — how many games were played on a date, for example. These carry nothing that identifies you.
• A record that a number asked to be deleted, so the same request is not processed twice.

Deletion is permanent. We cannot restore an account afterwards, and playing again later starts a new one from scratch.',
  'अपना डेटा हटवाना',
  'अपना खाता और उससे जुड़ी सारी जानकारी कैसे हटवाएँ।',
  E'आप जब चाहें अपना MastiPe खाता और उससे जुड़ा डेटा हटवा सकते हैं। कोई कारण बताने की ज़रूरत नहीं।

*कैसे कहें*

• अपने ईमेल से support@mastipe.in पर लिखिए और वह WhatsApp नंबर बताइए जिससे आप खेलते हैं।
• या उसी नंबर से WhatsApp पर हमें मैसेज कीजिए कि आप अपना डेटा हटवाना चाहते हैं।

*आगे क्या होता है*

• हम जाँचते हैं कि अनुरोध सचमुच उसी नंबर के मालिक का है। यही कदम आपकी सुरक्षा है।
• पुष्टि के बाद 30 दिनों के भीतर आपकी प्रोफ़ाइल, नाम, खेल का इतिहास, टिकट, संदेश और वॉलेट बैलेंस हटा दिए जाते हैं।
• बचे हुए क्रेडिट खाता हटाने पर समाप्त हो जाते हैं। रिफंड चाहिए तो पहले वह माँगिए।

*हम क्या रखते हैं, और क्यों*

• टैक्स इनवॉइस और भुगतान रिकॉर्ड। भारतीय कानून के तहत इन्हें रखना ज़रूरी है।
• बिना पहचान वाले आँकड़े, जिनमें आपकी पहचान कुछ भी नहीं होती।
• यह रिकॉर्ड कि किस नंबर ने हटाने को कहा था।

खाता हटाना स्थायी है। बाद में उसे वापस नहीं लाया जा सकता।',
  1, 60, false, true
)
ON CONFLICT (doc_key) DO UPDATE
   SET title       = EXCLUDED.title,
       summary     = EXCLUDED.summary,
       body        = EXCLUDED.body,
       title_hi    = EXCLUDED.title_hi,
       summary_hi  = EXCLUDED.summary_hi,
       body_hi     = EXCLUDED.body_hi,
       is_active   = true;
