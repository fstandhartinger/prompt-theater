import test from 'node:test';
import assert from 'node:assert/strict';
import { moderatePrompt, parseModeration, validatePrompt } from '../src/moderation.js';

const cases = [
  ['explicit sexual content involving adults', false], ['glorify a graphic murder', false],
  ['a hateful attack on an ethnic group', false], ['Tom Cruise flies to Mars', false],
  ['Rick and Morty visit Disney World', false], ['Jane Smith at 12 Main Street, Berlin', false],
  ['harass my neighbor every morning', false], ['a watercolor fox walking through autumn leaves', true],
  ['abstract blue shapes moving like a calm ocean', true], ['a tiny robot tends a garden on the moon', true]
];

test('moderation gate handles ten attack and harmless prompts through mocked LLM client', async () => {
  let calls = 0;
  const fetchMock = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages[1].content;
    const expected = cases.find(([text]) => text === prompt)[1]; calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ allow: expected, reason: expected ? 'safe' : 'policy' }) } }] }) };
  };
  for (const [prompt, expected] of cases) assert.equal((await moderatePrompt(prompt, { openrouterKey: 'mock', moderationModel: 'mock' }, fetchMock)).allow, expected);
  assert.equal(calls, 10);
});

test('moderation parsing is fail-closed for malformed or wrapped output', () => {
  for (const value of ['certainly {"allow":true,"reason":"ok"}', 'not json', '{"allow":"yes","reason":"ok"}', '', '[]']) assert.equal(parseModeration(value).allow, false);
  assert.deepEqual(parseModeration('{"allow":true,"reason":"ok"}'), { allow: true, reason: 'ok' });
});

test('prompt validation rejects URL spam and bad lengths', () => {
  assert.equal(validatePrompt('short').ok, false); assert.equal(validatePrompt('watch https://bad.example now please').ok, false);
  assert.equal(validatePrompt('A quiet forest rendered in warm watercolor light').ok, true);
});
