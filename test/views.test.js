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
