import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import { testDatabaseUrl, stopTestDatabase, resetSchema } from './helpers/pg.js';
import { startApp, stripeStub } from './helpers/app.js';

let db, databaseUrl, tmpDir;

const baseCfg = () => ({
  databaseUrl, compositor: false, worker: false, webhookSecret: 'whsec_seo_test',
  publicUrl: 'https://prompt-theater.app.mintapis.com', priceCents: 400,
  moderationFake: true, falFake: true,
  dataDir: tmpDir, scenesDir: path.join(tmpDir, 'scenes'),
  interstitial: path.join(tmpDir, 'interstitial.mp4'),
  stageFifo: path.join(tmpDir, 'stage.ts'), errorTtlMs: 60000,
});

before(async () => {
  databaseUrl = await testDatabaseUrl();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-theater-seo-'));
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

test('every public page responds 200 with its canonical and metadata', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const pages = [
    ['/', 'Live — Watch Your Idea Become an AI Video'],
    ['/about', 'How Prompt Theater Works'],
    ['/how', 'Screening &amp; Refunds'],
    ['/your-prompt', 'Your Prompt'],
    ['/privacy', 'Privacy Policy'],
    ['/imprint', 'Imprint'],
  ];
  // Canonical must be the stable public origin, not the ephemeral test port.
  const publicOrigin = 'https://prompt-theater.app.mintapis.com';
  for (const [route, title] of pages) {
    const response = await fetch(`${app.base}${route}`);
    assert.equal(response.status, 200, `${route} must be 200`);
    const html = await response.text();
    assert.match(html, new RegExp(`<title>${title} — Prompt Theater</title>`), `${route} title`);
    assert.ok(html.includes(`<link rel="canonical" href="${publicOrigin}${route}">`), `${route} canonical`);
    assert.match(html, /<meta property="og:title"/, `${route} og:title`);
    assert.match(html, /<meta name="twitter:card"/, `${route} twitter card`);
    assert.match(html, /<meta name="description" content="[^"]{60,}"/, `${route} description`);
    assert.ok(!html.includes('undefined'), `${route} must not leak undefined`);
    assert.ok(!html.includes('NaN'), `${route} must not leak NaN`);
  }
});

test('robots.txt, sitemap.xml and llms.txt are served with correct types', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const robots = await fetch(`${app.base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const robotsText = await robots.text();
  assert.match(robotsText, /Disallow: \/api\//);
  assert.ok(!robotsText.includes('Disallow: /scene/'), 'crawlers must be able to read dynamic scene noindex tags');
  assert.match(robotsText, /Sitemap: https:\/\/prompt-theater\.app\.mintapis\.com\/sitemap\.xml/);

  const sitemap = await fetch(`${app.base}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /application\/xml/);
  const sitemapText = await sitemap.text();
  assert.match(sitemapText, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.ok(!sitemapText.includes('/scene/'), 'dynamic scenes stay out of the sitemap');

  const llms = await fetch(`${app.base}/llms.txt`);
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get('content-type'), /text\/plain/);
  assert.match(await llms.text(), /Prompt Theater/);
});

test('the IndexNow proof key is served at the root verification path', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const key = await fetch(`${app.base}/fc30d6f5bd66213395ee6edc0ba8e755.txt`);
  assert.equal(key.status, 200);
  assert.equal(await key.text(), 'fc30d6f5bd66213395ee6edc0ba8e755\n');
});

test('home and screening pages provide matching visible product and FAQ structured data', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const home = await (await fetch(`${app.base}/`)).text();
  assert.match(home, /"@type":"Product"/);
  const how = await (await fetch(`${app.base}/how`)).text();
  assert.match(how, /"@type":"FAQPage"/);
  assert.match(how, /Common questions/);
  assert.match(how, /"@type":"Question"/);
  assert.match(how, /What happens if my prompt is rejected\?/);
});

test('brand assets are served and the page references them', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  for (const [route, type] of [['/brand/og-image.png', /image\/png/], ['/brand/favicon.svg', /image\/svg\+xml/], ['/brand/logo.svg', /image\/svg\+xml/]]) {
    const response = await fetch(`${app.base}${route}`);
    assert.equal(response.status, 200, `${route}`);
    assert.match(response.headers.get('content-type'), type, `${route} content-type`);
  }
  const html = await (await fetch(`${app.base}/`)).text();
  assert.match(html, /<link rel="icon" href="\/brand\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /og:image" content="https:\/\/prompt-theater\.app\.mintapis\.com\/brand\/og-image\.png"/);
});

test('the privacy policy keeps the analytics disclosure and facts', async t => {
  const app = await startApp({ cfg: baseCfg(), db, stripe: stripeStub() });
  t.after(() => app.close());
  const privacy = await (await fetch(`${app.base}/privacy`)).text();
  assert.match(privacy, /Umami/);
  assert.match(privacy, /Do Not Track and Global Privacy Control stop this measurement/);
  assert.match(privacy, /info@productivity-boost\.com/);
  const imprint = await (await fetch(`${app.base}/imprint`)).text();
  assert.match(imprint, /HRB 8453/);
  assert.match(imprint, /DE296812612/);
});

test('the live checkout and health paths are untouched by the revamp', async t => {
  const stripe = stripeStub();
  const app = await startApp({ cfg: baseCfg(), db, stripe });
  t.after(() => app.close());
  const response = await fetch(`${app.base}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A lighthouse in a storm painted in thick oils' })
  });
  assert.equal(response.status, 200);
  assert.equal(stripe.calls.sessions.length, 1, 'checkout must still create a Stripe session');
  assert.equal(stripe.calls.sessions[0].line_items[0].price_data.unit_amount, 400);
  const health = await (await fetch(`${app.base}/healthz`)).json();
  assert.equal(health.ok, true);
});
