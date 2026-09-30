import test from 'node:test';
import assert from 'node:assert/strict';
import { home, scenePage, about, how, yourPrompt, robotsTxt, sitemapXml, llmsTxt } from '../src/views.js';

const page = (extra = {}) => home({
  scenes: [], today: 0, price: 400, publicUrl: 'https://theater.test', purchase: null, ...extra
});

// Finding 12: the page promised things the code did not do.
test('the home page describes what actually happens to a prompt', () => {
  const html = page();
  assert.match(html, /checked against our content rules after payment and before generation/i);
  assert.match(html, /refunded in full/i);
  assert.match(html, /including any VAT/i);
  assert.match(html, /Only scenes that have been paid for and cleared moderation appear in the feed/i);
  assert.ok(!/Prompts are moderated; rejected prompts are refunded\./.test(html),
    'the old unconditional promise must be gone');
});

// Finding 4: a player without an error handler stays dead after the first hiccup.
test('the player recovers from stream errors', () => {
  const html = page();
  assert.match(html, /Hls\.Events\.ERROR/);
  assert.match(html, /startLoad\(\)/);
  assert.match(html, /recoverMediaError\(\)/);
});

test('the purchase confirmation names the scene and the refund promise', () => {
  const html = page({ purchase: { id: 42, status: 'moderating', sceneSeconds: 15 } });
  assert.match(html, /Payment received/);
  assert.match(html, /\/scene\/42/);
  assert.match(html, /refunded automatically/i);
});

test('user text is escaped everywhere it is rendered', () => {
  const nasty = '<img src=x onerror=alert(1)>&"\'';
  const html = page({ scenes: [{ id: 1, status: 'played', prompt_display: nasty }] });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
  assert.ok(!scenePage({ id: 2, status: 'played', prompt_display: nasty }).includes('<img src=x'));
});

// ---------------------------------------------------------------------------
// The four wording/markup changes Florian asked for (ui-changes.md).
// ---------------------------------------------------------------------------
test('the prompt hint allows real people, because the show is satire', () => {
  const html = page();
  assert.ok(!/No real people/i.test(html), 'the blanket ban on real people must be gone');
  assert.match(html, /10–300 characters\. No protected characters, sexual content, hate, harassment, or personal data\./);
});

test('the hint under the player is plain language, not HLS jargon', () => {
  const html = page();
  assert.ok(!/HLS segments/i.test(html), 'viewers do not know what an HLS segment is');
  assert.match(html, /Give it a moment to start\./);
});

test('recent scenes are collapsible and start collapsed', () => {
  const html = page({ scenes: [{ id: 7, status: 'played', prompt_display: 'FEED_MARKER' }] });
  assert.match(html, /<details class="panel"><summary>Recent scenes<\/summary>/);
  assert.ok(!/<details[^>]*\bopen\b/.test(html), 'the panel must be closed by default');
  const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
  assert.ok(details.includes('FEED_MARKER'), 'the feed must live inside the collapsible panel');
  assert.ok(!/<h2>Recent scenes<\/h2>/.test(html), 'the old static heading must be gone');
  assert.match(html, /summary\{cursor:pointer/, 'the summary must look and feel clickable');
});

// ---------------------------------------------------------------------------
// The revamp: the concept must be obvious above the fold, and every page needs
// truthful, page-specific SEO metadata.
// ---------------------------------------------------------------------------
test('the home page says what the product is before the form', () => {
  const html = page();
  const h1 = html.match(/<h1>(.*?)<\/h1>/)?.[1];
  assert.ok(h1, 'the home page needs a headline');
  assert.match(h1, /scene/i);
  assert.match(html, /live/i, 'the live concept must be visible');
  assert.match(html, /AI-generated/i);
  assert.match(html, /within a few minutes/i);
  assert.match(html, /id="player"/, 'the live player stays on the page');
  assert.match(html, /id="buy"/, 'the checkout form stays on the page');
});

test('mobile reading order puts the value proposition and checkout before the live player', () => {
  const html = page();
  assert.ok(html.indexOf('class="stack action-stack"') < html.indexOf('class="stack live-stack"'));
  assert.match(html, /\.hero \.live-stack\{grid-column:1;grid-row:1\}/, 'desktop keeps the player in the left column');
  assert.match(html, /\.hero \.action-stack\{grid-column:2;grid-row:1\}/, 'desktop keeps the purchase panel in the right column');
});

test('pricing and scene duration metadata follow the configured product settings', () => {
  const html = page({ price: 725, sceneSeconds: 22 });
  assert.match(html, /pay \$7\.25/);
  assert.match(html, /22-second AI-generated clip/);
  assert.match(html, /Describe a 22-second scene/);
  assert.match(html, /"price":"7\.25"/);
  assert.match(about(725, 22), /22-second AI-generated clip/);
  assert.match(scenePage({ id: 12, status: 'played', prompt_display: 'x' }, 'https://theater.test', 22), /22-second AI-generated satire clip/);
});

test('the home page carries complete page-specific metadata', () => {
  const html = page();
  assert.match(html, /<title>Live — Watch Your Idea Become an AI Video — Prompt Theater<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,}"/, 'descriptions should be substantial');
  assert.match(html, /<link rel="canonical" href="https:\/\/prompt-theater\.app\.mintapis\.com\/">/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:description"/);
  assert.match(html, /<meta property="og:url" content="https:\/\/prompt-theater\.app\.mintapis\.com\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/prompt-theater\.app\.mintapis\.com\/brand\/og-image\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<script type="application\/ld\+json">.*SoftwareApplication.*<\/script>/s, 'SoftwareApplication structured data');
  assert.match(html, /<script type="application\/ld\+json">.*"Organization".*<\/script>/s, 'Organization structured data');
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<script defer src="\/analytics\.js"><\/script>/, 'the privacy-gated analytics script stays');
  const titles = [...html.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1]);
  assert.equal(titles.length, 1, 'exactly one title per page');
});

test('the explanatory pages exist, differ from each other and link back', () => {
  const pages = [
    [about(), /How it works/],
    [how(), /Screening & Refunds/],
    [yourPrompt(), /Your Prompt/],
  ];
  for (const [html] of pages) {
    assert.match(html, /<link rel="canonical" href="https:\/\/prompt-theater\.app\.mintapis\.com\/(about|how|your-prompt)\/?">/, 'canonical per page');
    assert.match(html, /rel="canonical"/);
    assert.match(html, /twitter:card/);
    assert.match(html, /SoftwareApplication/);
  }
  const [a, h, p] = pages.map(([html]) => html);
  assert.ok(a !== h && h !== p && a !== p, 'each page must have its own content');
  assert.match(a, /href="\/how"/, 'internal links');
  assert.match(h, /href="\/privacy"/);
  assert.match(p, /href="\/privacy"/);
  assert.match(p, /info@productivity-boost\.com/, 'the contact route for erasure stays');
});

test('the refund and screening claims on /how match the product', () => {
  const html = how();
  assert.match(html, /after payment and before generation/i);
  assert.match(html, /refunded in full/i);
  assert.match(html, /public figures/i);
  assert.match(html, /no hidden fees/i);
  assert.ok(!/30-day money-back/i.test(html), 'no invented guarantee');
});

test('your-prompt states the processing facts without inventing new ones', () => {
  const html = yourPrompt();
  assert.match(html, /moderation model/i);
  assert.match(html, /video generation service/i);
  assert.match(html, /statutory retention/i);
  assert.match(html, /Arts\. 15–21 GDPR/);
});

test('dynamic scene pages are noindex and stay out of the sitemap', () => {
  const html = scenePage({ id: 9, status: 'played', prompt_display: 'x' });
  assert.match(html, /<meta name="robots" content="noindex,follow">/);
  const sitemap = sitemapXml();
  assert.ok(!sitemap.includes('/scene/'), 'no dynamic scene URLs in the sitemap');
  assert.match(sitemap, /<loc>https:\/\/prompt-theater\.app\.mintapis\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/prompt-theater\.app\.mintapis\.com\/about<\/loc>/);
});

test('robots.txt blocks private paths and points at the sitemap', () => {
  const txt = robotsTxt();
  assert.match(txt, /User-agent: \*/);
  for (const prefix of ['/api/', '/hls/', '/media/']) assert.match(txt, new RegExp(`Disallow: ${prefix}`));
  assert.ok(!txt.includes('Disallow: /scene/'), 'crawlers must be able to read each scene page noindex tag');
  assert.match(txt, /Sitemap: https:\/\/prompt-theater\.app\.mintapis\.com\/sitemap\.xml/);
});

test('llms.txt describes the product truthfully and links the pages', () => {
  const txt = llmsTxt();
  assert.match(txt, /live, participatory AI video show/i);
  assert.match(txt, /\$4\.00/);
  assert.match(txt, /refunded in full/i);
  for (const page of ['/about', '/how', '/your-prompt', '/privacy', '/imprint']) assert.match(txt, new RegExp(`https://prompt-theater\\.app\\.mintapis\\.com${page}`));
  assert.match(txt, /fc30d6f5bd66213395ee6edc0ba8e755\.txt/);
});
