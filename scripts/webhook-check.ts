/**
 * Checks a WhatsApp webhook end to end, the way Meta will.
 *
 *   npx tsx scripts/webhook-check.ts                  # local, via .env
 *   npx tsx scripts/webhook-check.ts https://x.ngrok-free.dev
 *
 * Meta's dashboard gives one error for every failure — "The callback URL or
 * verify token couldn't be validated" — which covers a wrong token, a tunnel
 * that is down, a TLS problem and a server that never started. This separates
 * them, in the order they fail.
 *
 * Nothing here makes the bot message anybody. The only payload it posts is a
 * delivery receipt, which the service records and does not answer. Sending a
 * fake *message* would make the bot reply to a real phone — so that step is
 * left to a human sending "hi" from their own handset.
 */

import { createHmac } from 'node:crypto';
import { apiPath, env } from '../src/config/env.js';

const base = (process.argv[2] ?? env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT}`).replace(
  /\/+$/,
  '',
);
const webhook = `${base}${apiPath(env.WHATSAPP_WEBHOOK_PATH)}`;

const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => console.log(`  ✗ ${m}`);

console.log(`\nWebhook: ${webhook}\n`);

let failures = 0;

/* 1 ------------------------------------------------ is anything answering? */

console.log('1. The server is reachable at that URL');
try {
  const res = await fetch(`${base}${apiPath('/public/health')}`, {
    headers: { 'ngrok-skip-browser-warning': '1' },
  });
  const body = (await res.json()) as { status?: string; checks?: Record<string, string> };
  if (res.ok && body.status === 'ok') pass(`health says ok — ${JSON.stringify(body.checks ?? {})}`);
  else {
    failures += 1;
    fail(`health returned ${res.status} ${JSON.stringify(body)}`);
  }
} catch (err) {
  failures += 1;
  fail(`cannot reach it at all: ${(err as Error).message}`);
  fail('is the server running, and is ngrok pointing at the right port?');
}

/* 2 --------------------------------------- the handshake Meta does on save */

console.log('\n2. Verification handshake (what "Verify and save" does)');
const challenge = String(Math.floor(Math.random() * 1e9));
try {
  const url =
    `${webhook}?hub.mode=subscribe` +
    `&hub.verify_token=${encodeURIComponent(env.WHATSAPP_VERIFY_TOKEN)}` +
    `&hub.challenge=${challenge}`;

  const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
  const text = (await res.text()).trim();

  if (res.status === 200 && text === challenge) {
    pass(`echoed the challenge — paste "${env.WHATSAPP_VERIFY_TOKEN}" as the verify token`);
  } else {
    failures += 1;
    fail(`expected 200 and "${challenge}", got ${res.status} and "${text.slice(0, 80)}"`);
  }
} catch (err) {
  failures += 1;
  fail((err as Error).message);
}

/* 3 ------------------------------------- a wrong token must be turned away */

console.log('\n3. A wrong verify token is refused');
try {
  const res = await fetch(
    `${webhook}?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=${challenge}`,
    { headers: { 'ngrok-skip-browser-warning': '1' } },
  );
  if (res.status === 403) pass('refused with 403, as it should be');
  else {
    failures += 1;
    fail(`expected 403, got ${res.status} — anybody could claim this webhook`);
  }
} catch (err) {
  failures += 1;
  fail((err as Error).message);
}

/* 4 -------------------------------------- an unsigned POST must be refused */

const receipt = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '0',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: env.WHATSAPP_BUSINESS_NUMBER,
              phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
            },
            // A delivery receipt, not a message: the service records it and
            // does not reply, so running this check messages nobody.
            statuses: [
              {
                id: `wamid.webhook-check.${Date.now()}`,
                status: 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
                recipient_id: env.WHATSAPP_BUSINESS_NUMBER,
              },
            ],
          },
        },
      ],
    },
  ],
});

console.log('\n4. An unsigned POST is refused');
try {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: receipt,
  });
  if (res.status === 401 || res.status === 403) pass(`refused with ${res.status}`);
  else {
    failures += 1;
    fail(`expected 401/403, got ${res.status} — anyone could post fake events`);
  }
} catch (err) {
  failures += 1;
  fail((err as Error).message);
}

/* 5 -------------------------------------- a correctly signed POST is taken */

console.log('\n5. A correctly signed POST is accepted');
if (!env.WHATSAPP_APP_SECRET) {
  fail('WHATSAPP_APP_SECRET is empty — cannot sign, and Meta’s events would be refused');
  failures += 1;
} else {
  const signature = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(receipt).digest('hex');
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
        'ngrok-skip-browser-warning': '1',
      },
      body: receipt,
    });
    if (res.status === 200) pass('accepted — signatures match, the pipeline is live');
    else {
      failures += 1;
      fail(`expected 200, got ${res.status} — check WHATSAPP_APP_SECRET matches the app`);
    }
  } catch (err) {
    failures += 1;
    fail((err as Error).message);
  }
}

/* ------------------------------------------------------------- what to do */

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);

if (failures === 0) {
  console.log('\nIn the Meta dashboard → WhatsApp → Configuration:');
  console.log(`  Callback URL : ${webhook}`);
  console.log(`  Verify token : ${env.WHATSAPP_VERIFY_TOKEN}`);
  console.log('  Then click Manage and subscribe to the "messages" field —');
  console.log('  without it, verification succeeds and nothing is ever delivered.');
  console.log('\nThe real test is sending "hi" from a phone. Watch for msg.in in the log.');
}

process.exit(failures === 0 ? 0 : 1);
