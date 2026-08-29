import express from 'express';
import fs from 'node:fs/promises';
import Stripe from 'stripe';
import { config } from './config.js';
import { createDb } from './db.js';
import { createPipeline } from './pipeline.js';
import { validatePrompt } from './moderation.js';
import { startCompositor } from './compositor.js';
import { home, scenePage, privacy, imprint } from './views.js';

export async function createApp(overrides = {}) {
  const cfg = { ...config(), ...overrides.cfg };
  const db = overrides.db || createDb(cfg.databaseUrl); await db.migrate();
  const stripe = overrides.stripe || (cfg.stripeKey ? new Stripe(cfg.stripeKey) : null);
  const pipeline = overrides.pipeline || createPipeline({ db, cfg, stripe, moderator: overrides.moderator });
  const app = express(); let lastError = null;
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], cfg.webhookSecret); }
    catch (error) { return res.status(400).json({ error: `Invalid webhook: ${error.message}` }); }
    res.json({ received: true });
    if (event.type === 'checkout.session.completed') void (async () => {
      try {
        const session = event.data.object;
        const updated = await db.pool.query("UPDATE scenes SET status='moderating',updated_at=now() WHERE stripe_session_id=$1 AND status='awaiting_payment' RETURNING *", [session.id]);
        if (!updated.rows[0]) return;
        await db.pool.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['scene.status', JSON.stringify({ scene_id: updated.rows[0].id, status: 'moderating' })]);
        await pipeline.process(updated.rows[0]);
      } catch (error) { lastError = error.message; console.error('webhook processing failed', error.message); }
    })();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/hls/*path', async (req, res) => {
    try {
      let suffix = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
      suffix = suffix.replace(/^live\/stream\//, 'stream/');
      const upstream = await fetch(`http://127.0.0.1:8888/${suffix}`);
      if (!upstream.ok) return res.sendStatus(upstream.status);
      res.type(upstream.headers.get('content-type') || 'application/octet-stream');
      res.set('cache-control', 'no-store'); res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.sendStatus(503); }
  });
  app.post('/api/checkout', async (req, res) => {
    const checked = validatePrompt(req.body?.prompt); if (!checked.ok) return res.status(400).json({ error: checked.error });
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured.' });
    try {
      const session = await stripe.checkout.sessions.create({ mode: 'payment', success_url: `${cfg.publicUrl}/?payment=success`, cancel_url: `${cfg.publicUrl}/?payment=cancelled`, line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cfg.priceCents, product_data: { name: 'Prompt Theater scene' } } }], metadata: { prompt: checked.prompt } });
      const result = await db.pool.query("INSERT INTO scenes(prompt,prompt_display,status,stripe_session_id,amount_cents) VALUES($1,$2,'awaiting_payment',$3,$4) RETURNING id", [checked.prompt, checked.display, session.id, cfg.priceCents]);
      await db.pool.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['scene.created', JSON.stringify({ scene_id: result.rows[0].id })]);
      res.json({ url: session.url });
    } catch (error) { lastError = error.message; res.status(502).json({ error: 'Could not start checkout.' }); }
  });
  app.get('/', async (_req, res, next) => { try { const [recent, count] = await Promise.all([db.pool.query('SELECT * FROM scenes ORDER BY created_at DESC LIMIT 20'), db.pool.query("SELECT count(*)::int n FROM scenes WHERE created_at::date=CURRENT_DATE")]); res.send(home({ scenes: recent.rows, today: count.rows[0].n, price: cfg.priceCents, publicUrl: cfg.publicUrl })); } catch (e) { next(e); } });
  app.get('/scene/:id', async (req, res) => { if (!/^\d+$/.test(req.params.id)) return res.status(404).send('Not found'); const found = await db.pool.query('SELECT * FROM scenes WHERE id=$1', [req.params.id]); found.rows[0] ? res.send(scenePage(found.rows[0])) : res.status(404).send('Not found'); });
  app.get('/privacy', (_req,res) => res.send(privacy())); app.get('/imprint', (_req,res) => res.send(imprint()));
  app.use('/media', express.static(cfg.dataDir, { fallthrough: false, immutable: true, maxAge: '1d' }));
  app.get('/healthz', async (_req, res) => {
    const ready = await db.pool.query("SELECT count(*)::int n FROM scenes WHERE status='ready'"); let streamUp = false;
    try { const response = await fetch(cfg.hlsUrl); streamUp = response.ok && (await response.text()).includes('#EXTM3U'); } catch {}
    res.status(lastError ? 503 : 200).json({ ok: !lastError, stream_up: streamUp, scenes_ready: ready.rows[0].n, last_error: lastError });
  });
  app.use((error,_req,res,_next) => { lastError = error.message; console.error(error); res.status(500).json({ error: 'Internal server error.' }); });
  return { app, db, cfg, start: () => cfg.compositor && startCompositor(db, cfg) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { app, cfg, start } = await createApp(); await fs.mkdir(cfg.scenesDir, { recursive: true });
  app.listen(cfg.port, '0.0.0.0', () => { console.log(`Prompt Theater listening on ${cfg.port}`); start(); });
}
