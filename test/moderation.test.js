import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { moderatePrompt, parseModeration, validatePrompt } from '../src/moderation.js';
import { assertConfig } from '../src/config.js';

const cfg = { openrouterKey: 'mock', moderationModel: 'mock', moderationTimeoutMs: 2000 };
const reply = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('moderation forwards the policy and the prompt and honours the model verdict', async () => {
  const seen = [];
  const fetchMock = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return reply(JSON.stringify({ allow: false, reason: 'depicts a real person' }));
  };
  const verdict = await moderatePrompt('Tom Cruise flies to Mars', cfg, fetchMock);
  assert.deepEqual(verdict, { allow: false, reason: 'depicts a real person' });
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].body.messages[1].content, 'Tom Cruise flies to Mars');
  assert.match(seen[0].body.messages[0].content, /Return ONLY strict JSON/);
  const allowed = await moderatePrompt('a watercolor fox in autumn leaves', cfg,
    async () => reply(JSON.stringify({ allow: true, reason: 'harmless' })));
  assert.deepEqual(allowed, { allow: true, reason: 'harmless' });
});

// Finding 10: without response_format a chat model answers in a markdown block and every
// paying customer gets rejected.
test('moderation asks the model for JSON and still accepts a fenced JSON answer', async () => {
  let body = null;
  const verdict = await moderatePrompt('a tiny robot tends a garden', cfg, async (_url, init) => {
    body = JSON.parse(init.body);
    return reply('```json\n{"allow":true,"reason":"harmless"}\n```');
  });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(verdict, { allow: true, reason: 'harmless' });
});

test('moderation parsing is fail-closed for malformed or wrapped output', () => {
  for (const value of ['certainly {"allow":true,"reason":"ok"}', 'not json', '{"allow":"yes","reason":"ok"}', '', '[]',
    '```json\n{"allow":"true"}\n```', '```json\nnope\n```'])
    assert.equal(parseModeration(value).allow, false, `expected fail-closed for ${JSON.stringify(value)}`);
  assert.deepEqual(parseModeration('{"allow":true,"reason":"ok"}'), { allow: true, reason: 'ok' });
});

test('moderation upstream failures and exceptions are fail-closed', async () => {
  assert.equal((await moderatePrompt('x', cfg, async () => ({ ok: false, status: 500 }))).allow, false);
  assert.equal((await moderatePrompt('x', cfg, async () => { throw new Error('socket hang up'); })).allow, false);
});

// Finding 9: a hanging moderation endpoint used to block webhook processing for minutes.
test('moderation aborts a hanging endpoint instead of blocking indefinitely', async () => {
  const fetchMock = (_url, init) => new Promise((_resolve, reject) => {
    assert.ok(init.signal, 'moderation request must carry an AbortSignal');
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  });
  const startedAt = Date.now();
  // AbortSignal.timeout() does not hold the event loop open on its own; keep it alive so
  // the runner waits for the abort instead of declaring the loop drained.
  const keepAlive = setInterval(() => {}, 10);
  let verdict;
  try { verdict = await moderatePrompt('x', { ...cfg, moderationTimeoutMs: 150 }, fetchMock); }
  finally { clearInterval(keepAlive); }
  const elapsed = Date.now() - startedAt;
  assert.equal(verdict.allow, false);
  assert.ok(elapsed < 2000, `moderation should abort quickly, took ${elapsed}ms`);
});

// Finding 10: FAL_FAKE must not double as "moderation off".
test('a missing moderation key never opens the gate, not even with FAL_FAKE=1', async () => {
  assert.equal((await moderatePrompt('anything', { openrouterKey: '', falFake: true })).allow, false);
  assert.equal((await moderatePrompt('anything', { openrouterKey: '' })).allow, false);
  assert.equal((await moderatePrompt('anything', { openrouterKey: '', moderationFake: true })).allow, true);
});

test('startup refuses to run without a moderation key unless MODERATION_FAKE is explicit', () => {
  assert.throws(() => assertConfig({ openrouterKey: '', moderationFake: false, falFake: true }), /OPENROUTER_API_KEY/);
  assertConfig({ openrouterKey: 'sk-or-x', moderationFake: false });
  assertConfig({ openrouterKey: '', moderationFake: true });
});

test('the shipped .env.example does not enable any fake mode', async () => {
  const example = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of example.split('\n')) {
    assert.ok(!/^\s*(FAL_FAKE|MODERATION_FAKE)\s*=\s*(1|true)\s*$/i.test(line), `.env.example must not ship ${line.trim()}`);
  }
});

test('prompt validation rejects URL spam and bad lengths', () => {
  assert.equal(validatePrompt('short').ok, false);
  assert.equal(validatePrompt('watch https://bad.example now please').ok, false);
  assert.equal(validatePrompt('A quiet forest rendered in warm watercolor light').ok, true);
});

// Finding 7: the advertising filter only caught hostnames with two or more dots.
test('prompt validation rejects single-dot advertising domains', () => {
  for (const spam of ['Buy cheap watches now at spamshop.com today please',
    'visit spamshop.co.uk now for the best offers ever',
    'order at bestdeals.shop for a huge discount today',
    'find us on example.io for more information now']) {
    assert.equal(validatePrompt(spam).ok, false, `expected rejection for ${spam}`);
  }
  for (const fine of ['A lighthouse in a storm, painted in thick oils',
    'A tiny robot tends a garden on the moon at night',
    'Mrs. Bell walks her dog through a quiet snowy park']) {
    assert.equal(validatePrompt(fine).ok, true, `expected acceptance for ${fine}`);
  }
});
