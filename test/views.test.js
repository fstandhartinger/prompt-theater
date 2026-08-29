import test from 'node:test';
import assert from 'node:assert/strict';
import { home, scenePage } from '../src/views.js';

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
