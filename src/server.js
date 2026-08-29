import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import Stripe from 'stripe';
import { config, assertConfig } from './config.js';
import { createDb } from './db.js';
import { createPipeline } from './pipeline.js';
import { validatePrompt } from './moderation.js';
import { startCompositor } from './compositor.js';
import { startWorker } from './worker.js';
import { home, scenePage, privacy, imprint } from './views.js';

// Events that mean "the customer's money has actually arrived".
const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
// Events that mean the money will never arrive; the reserved scene is released.
const DEAD_EVENTS = new Set(['checkout.session.async_payment_failed', 'checkout.session.expired']);

export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return key => {
    const cutoff = now() - windowMs;
    for (const [existing, stamps] of hits) {
      const kept = stamps.filter(stamp => stamp > cutoff);
      if (kept.length) hits.set(existing, kept); else hits.delete(existing);
    }
    const stamps = hits.get(key) || [];
    if (stamps.length >= limit) return false;
    stamps.push(now()); hits.set(key, stamps);
    return true;
  };
}

export async function createApp(overrides = {}) {
  const cfg = { ...config(), ...overrides.cfg };
  if (!overrides.moderator) assertConfig(cfg);
  const db = overrides.db || createDb(cfg.databaseUrl); await db.migrate();
  const stripe = overrides.stripe || (cfg.stripeKey ? new Stripe(cfg.stripeKey) : null);
  const pipeline = overrides.pipeline || createPipeline({ db, cfg, stripe, moderator: overrides.moderator });
  const logger = overrides.logger || console;
  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  // Health must reflect current dependencies, not the last exception ever caught, and it
  // must not hand internal error text to anonymous callers.
  let lastError = null;
  const noteError = message => { lastError = { message, at: Date.now() }; };
  const allowCheckout = createRateLimiter({ limit: cfg.checkoutRateLimit, windowMs: cfg.checkoutRateWindowMs });

  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], cfg.webhookSecret); }
    catch (error) { return res.status(400).json({ error: `Invalid webhook: ${error.message}` }); }
    try {
      const session = event.data?.object || {};
      // Only durable bookkeeping happens here, so it can be finished before acking.
      // Everything expensive is picked up by the worker from the database.
      if (PAID_EVENTS.has(event.type)) {
        if (session.payment_status !== 'paid') {
          logger.log(`webhook: ${event.type} for ${session.id} ignored (payment_status=${session.payment_status})`);
        } else {
          const scene = await db.markSessionPaid(session.id, session.amount_total, session.customer_details?.email || null);
          if (!scene) logger.log(`webhook: no awaiting_payment scene for ${session.id} at ${session.amount_total}`);
        }
      } else if (DEAD_EVENTS.has(event.type)) {
        await db.abandonSession(session.id, `Payment did not complete (${event.type}).`);
      }
      lastError = null;
      res.json({ received: true });
    } catch (error) {
      // 500 makes Stripe redeliver, which is exactly what we want: nothing is lost.
      noteError(error.message);
      logger.error('webhook processing failed', error.message);
      res.status(500).json({ error: 'Webhook processing failed.' });
    }
  });

  app.use(express.json({ limit: '16kb' }));

  app.get('/hls/*path', async (req, res) => {
    try {
      let suffix = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
      suffix = suffix.replace(/^live\/stream\//, 'stream/');
      const upstream = await fetch(`${cfg.hlsBase}/${suffix}`);
      if (!upstream.ok) return res.sendStatus(upstream.status);
      res.type(upstream.headers.get('content-type') || 'application/octet-stream');
      res.set('cache-control', 'no-store'); res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.sendStatus(503); }
  });

  app.post('/api/checkout', async (req, res) => {
    const checked = validatePrompt(req.body?.prompt);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    if (!allowCheckout(req.ip || 'unknown')) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured.' });
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${cfg.publicUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${cfg.publicUrl}/?payment=cancelled`,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cfg.priceCents, tax_behavior: 'inclusive', product_data: { name: 'Prompt Theater scene' } } }],
        ...(cfg.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        metadata: { prompt: checked.prompt }
      });
      await db.createScene({ prompt: checked.prompt, display: checked.display, sessionId: session.id, amountCents: cfg.priceCents });
      lastError = null;
      res.json({ url: session.url });
    } catch (error) { noteError(error.message); logger.error('checkout failed', error.message); res.status(502).json({ error: 'Could not start checkout.' }); }
  });

  app.get('/', async (req, res, next) => {
    try {
      const sessionId = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]{1,120}$/.test(req.query.session_id) ? req.query.session_id : null;
      const [scenes, today, purchased] = await Promise.all([
        db.listPublicScenes(20), db.countScenesToday(),
        sessionId ? db.getSceneBySession(sessionId) : Promise.resolve(null)
      ]);
      const purchase = req.query.payment === 'success'
        ? { id: purchased?.id || null, status: purchased?.status || null, sceneSeconds: cfg.sceneSeconds }
        : null;
      res.send(home({ scenes, today, price: cfg.priceCents, publicUrl: cfg.publicUrl, purchase }));
    } catch (error) { next(error); }
  });

  app.get('/scene/:id', async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).send('Not found');
      const scene = await db.getScene(req.params.id);
      if (!scene || scene.status === 'awaiting_payment' || scene.status === 'abandoned') return res.status(404).send('Not found');
      res.send(scenePage(scene));
    } catch (error) { next(error); }
  });

  app.get('/privacy', (_req, res) => res.send(privacy()));
  app.get('/imprint', (_req, res) => res.send(imprint()));

  // Only scenes that have actually aired are downloadable; DATA_DIR is not a public mount.
  app.get('/media/scenes/:file', async (req, res, next) => {
    try {
      const match = /^(\d+)\.mp4$/.exec(req.params.file);
      if (!match) return res.sendStatus(404);
      const scene = await db.getScene(match[1]);
      if (!scene || scene.status !== 'played' || !scene.video_path) return res.sendStatus(404);
      res.sendFile(path.resolve(cfg.scenesDir, `${scene.id}.mp4`), { maxAge: '1d', immutable: true },
        error => { if (error && !res.headersSent) res.sendStatus(404); });
    } catch (error) { next(error); }
  });

  app.get('/healthz', async (_req, res) => {
    let dbOk = true, ready = null, refundsPending = null;
    try { await db.ping(); ready = await db.countReady(); refundsPending = await db.countUnsettledRefunds(); }
    catch { dbOk = false; }
    let streamUp = false;
    try { const response = await fetch(cfg.hlsUrl); streamUp = response.ok && (await response.text()).includes('#EXTM3U'); } catch {}
    const degraded = Boolean(lastError && Date.now() - lastError.at < cfg.errorTtlMs);
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, stream_up: streamUp, scenes_ready: ready, refunds_pending: refundsPending, degraded });
  });

  app.use((error, _req, res, _next) => {
    noteError(error.message); logger.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  });

  const stoppers = [];
  return {
    app, db, cfg, pipeline,
    start: () => {
      if (cfg.worker) stoppers.push(startWorker({ db, cfg, pipeline, logger }));
      if (cfg.compositor) stoppers.push(startCompositor({ db, cfg, pipeline, logger }));
    },
    stop: async () => { for (const stop of stoppers) await stop(); }
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { app, cfg, start } = await createApp();
  await fs.mkdir(cfg.scenesDir, { recursive: true });
  app.listen(cfg.port, '0.0.0.0', () => { console.log(`Prompt Theater listening on ${cfg.port}`); start(); });
}
