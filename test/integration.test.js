import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import { createPipeline } from '../src/pipeline.js';
import { startCompositor } from '../src/compositor.js';
import { startWorker, reconcileOnce } from '../src/worker.js';
import { config } from '../src/config.js';
import { testDatabaseUrl, stopTestDatabase, resetSchema } from './helpers/pg.js';
import { startApp, stripeStub, signedWebhook, checkoutEvent, WEBHOOK_SECRET, silentLogger } from './helpers/app.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let db, databaseUrl, tmpDir;

const baseCfg = () => ({
  databaseUrl, compositor: false, worker: false, webhookSecret: WEBHOOK_SECRET,
  publicUrl: 'http://test.local', priceCents: 400, moderationFake: true, falFake: true,
  dataDir: tmpDir, scenesDir: path.join(tmpDir, 'scenes'), interstitial: path.join(tmpDir, 'interstitial.mp4'),
  stageFifo: path.join(tmpDir, 'stage.ts'), errorTtlMs: 60000, workerPollMs: 25, staleMs: 50, heartbeatMs: 20
});

const seed = async (fields = {}) => {
  const row = {
    prompt: 'A tiny robot tends a garden on the moon', prompt_display: 'A tiny robot tends a garden on the moon',
    status: 'awaiting_payment', stripe_session_id: `cs_seed_${Math.random().toString(36).slice(2)}`,
    amount_cents: 400, ...fields
  };
  const keys = Object.keys(row);
  const { rows } = await db.pool.query(
    `INSERT INTO scenes(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map(key => row[key]));
  return rows[0];
};

const age = async (id, seconds) => db.pool.query(
  `UPDATE scenes SET updated_at=now() - ($2::int * interval '1 second') WHERE id=$1`, [id, seconds]);

const statusOf = async id => (await db.getScene(id)).status;

const waitFor = async (predicate, { timeout = 15000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

before(async () => {
  databaseUrl = await testDatabaseUrl();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-theater-it-'));
  await fs.mkdir(path.join(tmpDir, 'scenes'), { recursive: true });
  db = createDb(databaseUrl);
  await db.migrate();
});

after(async () => {
  if (db) await db.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  await stopTestDatabase();
});

beforeEach(async () => { await resetSchema(db); });

// ---------------------------------------------------------------------------
// Finding 3: generation used to start on any checkout.session.completed event.
// ---------------------------------------------------------------------------
test('webhook only accepts a session that is paid, for the expected amount', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());

  const unpaid = await seed();
  await signedWebhook(app.base, checkoutEvent('checkout.session.completed',
    { id: unpaid.stripe_session_id, payment_status: 'unpaid', amount_total: 400 }));
  assert.equal(await statusOf(unpaid.id), 'awaiting_payment', 'an unpaid session must not start work');

  const underpaid = await seed();
  await signedWebhook(app.base, checkoutEvent('checkout.session.completed',
    { id: underpaid.stripe_session_id, payment_status: 'paid', amount_total: 300 }));
  assert.equal(await statusOf(underpaid.id), 'awaiting_payment', 'a mismatched amount must not start work');

  const paid = await seed();
  const response = await signedWebhook(app.base, checkoutEvent('checkout.session.completed',
    { id: paid.stripe_session_id, payment_status: 'paid', amount_total: 400, customer_details: { email: 'buyer@example.com' } }));
  assert.equal(response.status, 200);
  const stored = await db.getScene(paid.id);
  assert.equal(stored.status, 'paid');
  assert.equal(stored.customer_email, 'buyer@example.com');
  assert.ok(stored.paid_at);
});

test('delayed payment methods are settled by async_payment_succeeded and cleaned up on failure', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());

  const later = await seed();
  await signedWebhook(app.base, checkoutEvent('checkout.session.completed',
    { id: later.stripe_session_id, payment_status: 'unpaid', amount_total: 400 }));
  await signedWebhook(app.base, checkoutEvent('checkout.session.async_payment_succeeded',
    { id: later.stripe_session_id, payment_status: 'paid', amount_total: 400 }));
  assert.equal(await statusOf(later.id), 'paid');

  const doomed = await seed();
  await signedWebhook(app.base, checkoutEvent('checkout.session.async_payment_failed',
    { id: doomed.stripe_session_id, payment_status: 'unpaid', amount_total: 400 }));
  assert.equal(await statusOf(doomed.id), 'abandoned', 'a failed payment must release the scene');

  const stale = await seed();
  await signedWebhook(app.base, checkoutEvent('checkout.session.expired',
    { id: stale.stripe_session_id, payment_status: 'unpaid', amount_total: 400 }));
  assert.equal(await statusOf(stale.id), 'abandoned');
});

test('duplicate deliveries of the same paid session are recorded exactly once', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const scene = await seed();
  const event = checkoutEvent('checkout.session.completed',
    { id: scene.stripe_session_id, payment_status: 'paid', amount_total: 400 });
  const responses = await Promise.all(Array.from({ length: 5 }, () => signedWebhook(app.base, event)));
  for (const response of responses) assert.equal(response.status, 200);
  const { rows } = await db.pool.query(
    "SELECT count(*)::int n FROM events WHERE kind='scene.status' AND detail->>'status'='paid' AND (detail->>'scene_id')::int=$1", [scene.id]);
  assert.equal(rows[0].n, 1);
});

// Finding 1 (second half): the webhook used to answer 200 before doing anything, so a
// crash meant Stripe never redelivered.
test('the webhook only acknowledges after the payment is persisted', async t => {
  const brokenDb = { ...db, migrate: async () => {}, markSessionPaid: async () => { throw new Error('database is down'); } };
  const app = await startApp({ cfg: baseCfg(), db: brokenDb, stripe: stripeStub() });
  t.after(() => app.close());
  const response = await signedWebhook(app.base, checkoutEvent('checkout.session.completed',
    { id: 'cs_broken', payment_status: 'paid', amount_total: 400 }));
  assert.equal(response.status, 500, 'a failed webhook must not be acknowledged, so Stripe retries');
});

// ---------------------------------------------------------------------------
// Finding 1: a restart during moderation/generation orphaned the paid scene.
// ---------------------------------------------------------------------------
test('a restart mid-flight never orphans a paid scene', async t => {
  const stranded = {
    moderating: await seed({ status: 'moderating' }),
    queued: await seed({ status: 'queued' }),
    generating: await seed({ status: 'generating', fal_request_id: 'req_live_1' }),
    playing: await seed({ status: 'playing', video_path: path.join(tmpDir, 'scenes', 'x.mp4') })
  };
  for (const scene of Object.values(stranded)) await age(scene.id, 30);

  const handled = [];
  const pipeline = {
    async process(scene) { handled.push(['process', scene.id]); await db.transition(scene.id, 'ready', {}, { video_path: 'v.mp4' }); },
    async resume(scene) { handled.push(['resume', scene.id]); await db.transition(scene.id, 'ready', {}, { video_path: 'v.mp4' }); },
    async retryRefund() { return null; }
  };
  const cfg = { ...config(), ...baseCfg(), staleMs: 5000 };
  const stop = startWorker({ db, cfg, pipeline, logger: silentLogger });
  t.after(() => stop());

  await waitFor(async () => {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int n FROM scenes WHERE status IN ('moderating','queued','generating')");
    return rows[0].n === 0;
  }, { label: 'stranded scenes to be picked up' });

  assert.equal(await statusOf(stranded.moderating.id), 'ready');
  assert.equal(await statusOf(stranded.queued.id), 'ready');
  assert.equal(await statusOf(stranded.generating.id), 'ready');
  assert.deepEqual(handled.find(([, id]) => id === stranded.generating.id), ['resume', stranded.generating.id],
    'a scene stuck in generating must be resumed, not restarted from scratch');
});

test('a scene stranded in playing by a dead compositor goes back on air', async t => {
  const scene = await seed({ status: 'playing', video_path: path.join(tmpDir, 'scenes', 'x.mp4') });
  await age(scene.id, 30);
  const recovered = await db.recoverStalePlaying(5000);
  assert.deepEqual(recovered, [scene.id]);
  assert.equal(await statusOf(scene.id), 'ready');
});

test('reconciliation leaves a scene alone while its owner is still alive', async t => {
  const fresh = await seed({ status: 'generating' });
  await db.heartbeat(fresh.id);
  assert.equal(await db.claimSceneForProcessing(60000), null, 'a heartbeating scene must not be stolen');
  const playing = await seed({ status: 'playing', video_path: 'x.mp4' });
  assert.deepEqual(await db.recoverStalePlaying(60000), []);
});

// ---------------------------------------------------------------------------
// Finding 2: a single transient Stripe error used to lose the refund silently.
// ---------------------------------------------------------------------------
test('a refund that fails once is retried until the customer has the money back', async t => {
  const stripe = stripeStub({ failRefunds: 1 });
  const cfg = { ...config(), ...baseCfg() };
  const pipeline = createPipeline({ db, cfg, stripe, moderator: async () => ({ allow: false, reason: 'depicts a real person' }), logger: silentLogger });
  const scene = await seed({ status: 'moderating' });

  await pipeline.process(scene);
  let row = await db.getScene(scene.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.refund_id, null);
  assert.equal(row.refund_needed, true, 'the debt to the customer must be persisted, not appended to a string');
  assert.equal(await db.countUnsettledRefunds(), 1);

  await reconcileOnce({ db, cfg, pipeline });
  row = await db.getScene(scene.id);
  assert.equal(row.refund_id, 're_test_2');
  assert.equal(row.refund_needed, false);
  assert.equal(await db.countUnsettledRefunds(), 0);
  for (const call of stripe.calls.refunds) {
    assert.equal(call.options?.idempotencyKey, `refund-scene-${scene.id}`, 'refunds must be idempotent across retries');
  }
});

test('the refund backlog is the metric for money we still owe', async t => {
  const stripe = stripeStub({ failRefunds: 99 });
  const cfg = { ...config(), ...baseCfg() };
  const pipeline = createPipeline({ db, cfg, stripe, moderator: async () => ({ allow: false, reason: 'nope' }), logger: silentLogger });
  await pipeline.process(await seed({ status: 'moderating' }));
  await pipeline.process(await seed({ status: 'moderating' }));
  assert.equal(await db.countUnsettledRefunds(), 2);
  const { rows } = await db.pool.query("SELECT refund_error FROM scenes WHERE refund_needed AND refund_id IS NULL LIMIT 1");
  assert.match(rows[0].refund_error, /503/);
});

test('a generation failure refunds too, and the daily cap refunds instead of silently dropping', async t => {
  const stripe = stripeStub();
  const cfg = { ...config(), ...baseCfg(), maxDailySpendUsd: 0.01 };
  const pipeline = createPipeline({ db, cfg, stripe, moderator: async () => ({ allow: true, reason: 'fine' }), logger: silentLogger });
  const scene = await seed({ status: 'moderating' });
  await pipeline.process(scene);
  const row = await db.getScene(scene.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /spend cap/i);
  assert.equal(row.refund_id, 're_test_1');
  assert.equal(row.refund_needed, false);
});

// ---------------------------------------------------------------------------
// Finding 11: the spend cap that actually runs in production is reserveSpend.
// ---------------------------------------------------------------------------
test('reserveSpend enforces the daily cap atomically under concurrency', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => db.reserveSpend(1000 + i, 120, 2000)));
  assert.equal(results.filter(Boolean).length, 16);
  assert.equal(await db.spentToday(), 1920);
  assert.equal(await db.reserveSpend(9999, 120, 2000), false);
});

test('reserveSpend is idempotent per scene so a retried generation cannot book twice', async () => {
  assert.equal(await db.reserveSpend(42, 120, 2000), true);
  assert.equal(await db.reserveSpend(42, 120, 2000), true);
  assert.equal(await db.spentToday(), 120);
});

// A cap that is not a real number used to read as "no limit": every comparison against
// NaN is false, so reserveSpend approved everything and the fal bill was unbounded.
test('an unusable daily cap stops spending instead of unlocking it', async () => {
  await assert.rejects(() => db.reserveSpend(77, 120, NaN), /invalid daily cap/);
  await assert.rejects(() => db.reserveSpend(77, 120, Number('20 USD' * 100)), /invalid daily cap/);
  assert.equal(await db.spentToday(), 0, 'nothing may be booked against a broken cap');
});

test('a malformed MAX_DAILY_SPEND_USD is refused at startup, not silently ignored', () => {
  const previous = process.env.MAX_DAILY_SPEND_USD;
  try {
    for (const bad of ['20 USD', 'twenty', '0', '-5']) {
      process.env.MAX_DAILY_SPEND_USD = bad;
      assert.throws(() => config(), /MAX_DAILY_SPEND_USD must be a positive number/, `accepted ${bad}`);
    }
    process.env.MAX_DAILY_SPEND_USD = '12.50';
    assert.equal(config().maxDailySpendUsd, 12.5);
  } finally {
    if (previous === undefined) delete process.env.MAX_DAILY_SPEND_USD;
    else process.env.MAX_DAILY_SPEND_USD = previous;
  }
});

// ---------------------------------------------------------------------------
// Finding 5: a failing ffmpeg used to leave the paid scene on 'playing' forever.
// ---------------------------------------------------------------------------
test('a scene that cannot be broadcast is retried and then refunded, never left on playing', async t => {
  await fs.writeFile(path.join(tmpDir, 'interstitial.mp4'), 'not a real video');
  const stripe = stripeStub();
  const cfg = { ...config(), ...baseCfg(), maxPlayAttempts: 2 };
  const pipeline = createPipeline({ db, cfg, stripe, moderator: async () => ({ allow: true, reason: 'ok' }), logger: silentLogger });
  const scene = await seed({ status: 'ready', video_path: path.join(tmpDir, 'scenes', 'broken.mp4') });

  const published = [];
  const stageFactory = async () => ({
    async publish(file) {
      published.push(file);
      if (file.endsWith('broken.mp4')) throw new Error('ffmpeg exited 1: moov atom not found');
      await sleep(20);
    },
    async stop() {}
  });
  const stop = startCompositor({ db, cfg, pipeline, logger: silentLogger, stageFactory });
  t.after(() => stop());

  const row = await waitFor(async () => {
    const current = await db.getScene(scene.id);
    return current.status === 'failed' ? current : null;
  }, { label: 'the unplayable scene to be refunded' });
  assert.equal(row.refund_id, 're_test_1');
  assert.match(row.error, /Playback failed after 2 attempts/);
  assert.equal(row.play_attempts, 2);
  const { rows } = await db.pool.query("SELECT count(*)::int n FROM scenes WHERE status='playing'");
  assert.equal(rows[0].n, 0, 'no scene may be left on playing');
});

// ---------------------------------------------------------------------------
// Finding 6: two compositors used to fight over the same RTMP path.
// ---------------------------------------------------------------------------
test('only one compositor can hold the stage', async t => {
  const other = createDb(databaseUrl);
  t.after(() => other.close());
  const first = await db.acquireLock('prompt-theater-compositor');
  assert.ok(first);
  assert.equal(await other.acquireLock('prompt-theater-compositor'), null);
  await first.release();
  const third = await other.acquireLock('prompt-theater-compositor');
  assert.ok(third, 'the lock must be released again');
  await third.release();
});

test('a second compositor instance stands by instead of publishing', async t => {
  await fs.writeFile(path.join(tmpDir, 'interstitial.mp4'), 'not a real video');
  const cfg = { ...config(), ...baseCfg() };
  const secondDb = createDb(databaseUrl);
  t.after(() => secondDb.close());
  let stages = 0;
  const stageFactory = async () => { stages++; return { async publish() { await sleep(30); }, async stop() {} }; };
  const pipeline = { async requestRefund() {} };
  const stopA = startCompositor({ db, cfg, pipeline, logger: silentLogger, stageFactory });
  const stopB = startCompositor({ db: secondDb, cfg, pipeline, logger: silentLogger, stageFactory });
  t.after(async () => { await stopA(); await stopB(); });
  await waitFor(async () => stages >= 1, { label: 'the first compositor to take the stage' });
  await sleep(500);
  assert.equal(stages, 1, 'a second compositor must not open a second publisher');
});

// ---------------------------------------------------------------------------
// Finding 7: unpaid, unmoderated prompts were published on the home page.
// ---------------------------------------------------------------------------
test('the public feed shows only paid, moderated scenes that have aired', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const hateful = 'All members of GROUP_X are vermin and should be driven out of the city tonight';
  await seed({ status: 'awaiting_payment', prompt: hateful, prompt_display: hateful });
  await seed({ status: 'rejected', prompt: 'rejected text here', prompt_display: 'REJECTED_MARKER' });
  await seed({ status: 'moderating', prompt: 'pending text here', prompt_display: 'MODERATING_MARKER' });
  const aired = await seed({ status: 'played', prompt_display: 'AIRED_MARKER', video_path: 'x.mp4' });

  const html = await (await fetch(app.base)).text();
  assert.ok(!html.includes('GROUP_X'), 'never-paid prompts must not reach the home page');
  assert.ok(!html.includes('REJECTED_MARKER'), 'rejected prompts must not reach the home page');
  assert.ok(!html.includes('MODERATING_MARKER'), 'unmoderated prompts must not reach the home page');
  assert.ok(html.includes('AIRED_MARKER'));

  const denied = await seed({ status: 'awaiting_payment', prompt_display: 'SECRET_MARKER' });
  assert.equal((await fetch(`${app.base}/scene/${denied.id}`)).status, 404);
  assert.equal((await fetch(`${app.base}/scene/${aired.id}`)).status, 200);
});

test('checkout is rate limited per client', async t => {
  const stripe = stripeStub();
  const app = await startApp({ cfg: { ...baseCfg(), checkoutRateLimit: 3, checkoutRateWindowMs: 60000 }, db, stripe });
  t.after(() => app.close());
  const buy = () => fetch(`${app.base}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A lighthouse in a storm painted in thick oils' })
  });
  assert.equal((await buy()).status, 200);
  assert.equal((await buy()).status, 200);
  assert.equal((await buy()).status, 200);
  assert.equal((await buy()).status, 429, 'a flood of checkouts must be refused');
  assert.equal(stripe.calls.sessions.length, 3);
});

// The rate limit only protects the service if it can tell clients apart. Express reads a
// STRING 'trust proxy' as a list of trusted addresses, not a hop count, so behind a
// reverse proxy every visitor collapsed onto the proxy's IP and five checkouts per
// window shut the shop for everybody.
test('the checkout rate limit counts real clients, not the reverse proxy', async t => {
  const stripe = stripeStub();
  const app = await startApp({ cfg: { ...baseCfg(), checkoutRateLimit: 3, checkoutRateWindowMs: 60000 }, db, stripe });
  t.after(() => app.close());
  assert.equal(app.cfg.trustProxy, 1, "'trust proxy' must be a hop count, not the string '1'");
  const buy = forwardedFor => fetch(`${app.base}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ prompt: 'A lighthouse in a storm painted in thick oils' })
  });
  for (let i = 1; i <= 6; i++) {
    assert.equal((await buy(`203.0.113.${i}`)).status, 200, `customer 203.0.113.${i} was refused`);
  }
  for (let i = 0; i < 3; i++) assert.equal((await buy('198.51.100.7')).status, 200);
  assert.equal((await buy('198.51.100.7')).status, 429, 'one noisy client must still be throttled');
});

// ---------------------------------------------------------------------------
// Finding 8: /healthz stayed 503 forever and leaked internal error text.
// ---------------------------------------------------------------------------
test('healthz recovers from a transient failure and never leaks internal errors', async t => {
  const stripe = stripeStub({ failSessions: 1 });
  const app = await startApp({ cfg: { ...baseCfg(), errorTtlMs: 300 }, db, stripe });
  t.after(() => app.close());
  const buy = () => fetch(`${app.base}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A lighthouse in a storm painted in thick oils' })
  });
  assert.equal((await buy()).status, 502);
  const degraded = await (await fetch(`${app.base}/healthz`)).json();
  assert.equal(degraded.degraded, true);

  assert.equal((await buy()).status, 200);
  const recovered = await fetch(`${app.base}/healthz`);
  const body = await recovered.json();
  assert.equal(recovered.status, 200, 'a recovered service must report healthy');
  assert.equal(body.degraded, false);
  const serialized = JSON.stringify(body);
  assert.ok(!/api\.stripe\.com/.test(serialized), `healthz must not leak internal error text: ${serialized}`);
  assert.ok(!('last_error' in body), 'healthz must not expose last_error');
});

test('healthz reports unhealthy when the database is unreachable', async t => {
  const brokenDb = { ...db, migrate: async () => {}, ping: async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432'); } };
  const app = await startApp({ cfg: baseCfg(), db: brokenDb, stripe: stripeStub() });
  t.after(() => app.close());
  const response = await fetch(`${app.base}/healthz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes('10.0.0.5'));
});

// ---------------------------------------------------------------------------
// Finding 12 and the DATA_DIR exposure noted alongside it.
// ---------------------------------------------------------------------------
test('checkout collects gross prices and points the buyer back to their scene', async t => {
  const stripe = stripeStub();
  const app = await startApp({ cfg: baseCfg(), db, stripe });
  t.after(() => app.close());
  await fetch(`${app.base}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A lighthouse in a storm painted in thick oils' })
  });
  const args = stripe.calls.sessions[0];
  assert.deepEqual(args.automatic_tax, { enabled: true });
  assert.equal(args.line_items[0].price_data.tax_behavior, 'inclusive');
  assert.match(args.success_url, /session_id=\{CHECKOUT_SESSION_ID\}/);
});

test('the home page confirms a completed purchase with its scene number', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const scene = await seed({ status: 'paid', stripe_session_id: 'cs_test_confirm_1' });
  const html = await (await fetch(`${app.base}/?payment=success&session_id=cs_test_confirm_1`)).text();
  assert.match(html, /Payment received/);
  assert.ok(html.includes(`/scene/${scene.id}`), 'the buyer must get a link to their own scene');
  const plain = await (await fetch(app.base)).text();
  assert.ok(!/Payment received/.test(plain));
});

test('videos are downloadable only once the scene has aired', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const ready = await seed({ status: 'ready', video_path: path.join(tmpDir, 'scenes', 'ready.mp4') });
  await fs.writeFile(path.join(tmpDir, 'scenes', `${ready.id}.mp4`), 'video-bytes');
  assert.equal((await fetch(`${app.base}/media/scenes/${ready.id}.mp4`)).status, 404);
  await db.transition(ready.id, 'played', {}, { played_at: new Date() });
  assert.equal((await fetch(`${app.base}/media/scenes/${ready.id}.mp4`)).status, 200);
  assert.equal((await fetch(`${app.base}/media/scenes/../../etc/passwd`)).status, 404);
});

test('expired videos are pruned so the disk cannot fill up', async () => {
  const file = path.join(tmpDir, 'scenes', 'old.mp4');
  await fs.writeFile(file, 'old-video');
  const old = await seed({ status: 'played', video_path: file });
  await db.pool.query("UPDATE scenes SET played_at=now() - interval '90 days' WHERE id=$1", [old.id]);
  for (let i = 0; i < 5; i++) await seed({ status: 'played', video_path: `keep-${i}.mp4`, });
  await db.pool.query("UPDATE scenes SET played_at=now() WHERE video_path LIKE 'keep-%'");
  const expired = await db.listExpiredVideos(30, 5);
  assert.deepEqual(expired.map(row => row.id), [old.id]);
  await db.forgetVideo(old.id);
  assert.equal((await db.getScene(old.id)).video_path, null);
});
