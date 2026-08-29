import pg from 'pg';
import Stripe from 'stripe';

const { Client } = pg;
const base = process.env.E2E_URL || 'http://127.0.0.1:3000';
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { console.error(`FAIL ${message}`); process.exit(1); };

const buy = async (prompt, { paymentStatus = 'paid', amountTotal = 400 } = {}) => {
  const sessionId = `cs_test_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inserted = await db.query(
    "INSERT INTO scenes(prompt,prompt_display,status,stripe_session_id,amount_cents) VALUES($1,$1,'awaiting_payment',$2,400) RETURNING id",
    [prompt, sessionId]);
  const payload = JSON.stringify({
    id: `evt_test_${Date.now()}_${Math.random().toString(36).slice(2)}`, object: 'event',
    api_version: '2025-07-30.basil', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1,
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', payment_status: paymentStatus, amount_total: amountTotal } }
  });
  const response = await fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload
  });
  return { id: inserted.rows[0].id, sessionId, response };
};

const waitForStatus = async (id, wanted, seconds = 120) => {
  for (let i = 0; i < seconds * 4; i++) {
    const row = (await db.query('SELECT status,error FROM scenes WHERE id=$1', [id])).rows[0];
    if (wanted.includes(row.status)) return row.status;
    if (['failed', 'rejected', 'abandoned'].includes(row.status) && !wanted.includes(row.status)) {
      fail(`scene ${id} ended as ${row.status}: ${row.error}`);
    }
    await sleep(250);
  }
  const row = (await db.query('SELECT status,error FROM scenes WHERE id=$1', [id])).rows[0];
  return fail(`scene ${id} never reached ${wanted} (last ${row.status}: ${row.error})`);
};

// --- 1. an unpaid session must not consume generation budget -----------------
const unpaid = await buy('An unpaid session that must never be generated at all', { paymentStatus: 'unpaid' });
if (!unpaid.response.ok) fail(`webhook rejected the unpaid event: ${unpaid.response.status}`);
await sleep(3000);
const unpaidStatus = (await db.query('SELECT status FROM scenes WHERE id=$1', [unpaid.id])).rows[0].status;
if (unpaidStatus !== 'awaiting_payment') fail(`unpaid session started work (status ${unpaidStatus})`);
console.log('PASS unpaid checkout session is ignored');

// --- 2. the happy path -------------------------------------------------------
const first = await buy('A tiny friendly robot plants flowers beneath a violet moon');
if (!first.response.ok) fail(`webhook failed: ${first.response.status} ${await first.response.text()}`);
console.log('PASS webhook signature accepted');
const reached = await waitForStatus(first.id, ['ready', 'playing', 'played']);
console.log(`PASS fake generation reached ${reached}`);

// --- 3. the stream must be continuously watchable ----------------------------
let health, segments = 0;
for (let i = 0; i < 90; i++) {
  health = await (await fetch(`${base}/healthz`)).json();
  if (health.stream_up) {
    const playlist = await (await fetch(`${base}/hls/live/stream/main_stream.m3u8`)).text();
    segments = (playlist.match(/#EXTINF/g) || []).length;
    if (segments >= 2) break;
  }
  await sleep(1000);
}
if (!health?.stream_up || segments < 2) fail(`stream unhealthy: ${JSON.stringify(health)}, segments=${segments}`);
console.log(`PASS HLS stream_up with ${segments} segments`);

// A new scene forces a clip boundary while we watch. With a publisher per clip the
// MediaMTX muxer is destroyed here: the playlist 404s and segment names restart.
const second = await buy('A paper boat drifts down a rain-soaked city street at dusk');
if (!second.response.ok) fail(`second webhook failed: ${second.response.status}`);

const prefixes = new Set();
let samples = 0, unavailable = 0, lastSequence = -1, sequenceWentBackwards = 0;
const until = Date.now() + 45000;
while (Date.now() < until) {
  samples++;
  const index = await fetch(`${base}/hls/live/stream/index.m3u8`);
  if (!index.ok || !(await index.text()).includes('#EXTM3U')) unavailable++;
  const media = await fetch(`${base}/hls/live/stream/main_stream.m3u8`);
  if (media.ok) {
    const body = await media.text();
    for (const name of body.match(/^[^#\s]+\.ts/gm) || []) prefixes.add(name.split('_')[0]);
    const sequence = Number((body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] ?? NaN);
    if (Number.isFinite(sequence)) {
      if (sequence < lastSequence) sequenceWentBackwards++;
      lastSequence = sequence;
    }
  } else unavailable++;
  await sleep(300);
}
const playedSecond = (await db.query('SELECT status FROM scenes WHERE id=$1', [second.id])).rows[0].status;
if (unavailable > 0) fail(`playlist was unavailable in ${unavailable}/${samples} samples across a scene boundary`);
if (prefixes.size !== 1) fail(`HLS muxer restarted: segment prefixes seen = ${[...prefixes].join(', ')}`);
if (sequenceWentBackwards > 0) fail(`media sequence restarted ${sequenceWentBackwards} time(s)`);
console.log(`PASS stream stayed continuous over ${samples} samples across a scene boundary (second scene: ${playedSecond})`);

// --- 4. money that is owed is visible ----------------------------------------
const owed = await (await fetch(`${base}/healthz`)).json();
if (owed.refunds_pending !== 0) fail(`refunds are outstanding: ${owed.refunds_pending}`);
if ('last_error' in owed) fail('healthz leaks last_error');
console.log('PASS no outstanding refunds and no internal error text on /healthz');

// --- 5. the public feed only shows paid, moderated, aired scenes -------------
const home = await (await fetch(`${base}/`)).text();
if (home.includes('An unpaid session that must never be generated at all')) fail('home page shows an unpaid prompt');
console.log('PASS home page hides unpaid prompts');

await db.end();
