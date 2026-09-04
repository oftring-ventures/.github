import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUsage, parseUsageLog } from './review-usage.mjs';

const event = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } };
const log = `2026-09-04T01:02:03.123Z ${JSON.stringify(event)}\n`;
const env = { GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 'test-placeholder' };

test('sums completed turns without counting nested command output as usage', () => {
  const result = parseUsageLog(log + log + JSON.stringify({ type: 'item.completed',
    item: { aggregated_output: JSON.stringify(event) } }));
  assert.deepEqual(result.usage, { input_tokens: 200, cached_input_tokens: 160, output_tokens: 40 });
  assert.equal(result.completed_turns, 2);
});

test('missing or invalid tokens are unknown, while zero is valid measured usage', () => {
  for (const input of ['', '{}', JSON.stringify({ type: 'turn.completed' }),
    JSON.stringify({ ...event, usage: { ...event.usage, cached_input_tokens: 101 } }),
    JSON.stringify({ ...event, usage: { ...event.usage, input_tokens: '100' } })]) {
    assert.equal(parseUsageLog(input).usage, null);
  }
  assert.deepEqual(parseUsageLog(JSON.stringify({ ...event, usage: {
    input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } })).usage,
  { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
  const failure = parseUsageLog(JSON.stringify({ type: 'turn.failed', error: { message: '429 rate limit' } }));
  assert.equal(failure.rate_limited, true);
  assert.equal(failure.failed_turns, 1);
  assert.equal(failure.usage, null);
});

test('uses exact workflow attempt, strips auth on log redirect, retains no raw log data', async () => {
  const calls = [];
  const result = await collectUsage(env, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ total_count: 2, jobs: [
      { id: 11, name: 'codex_review / Codex review', conclusion: 'success',
        started_at: '2026-09-04T00:00:00Z', completed_at: '2026-09-04T00:01:00Z' },
      { id: 12, name: 'codex_review / Codex review gate', conclusion: null },
    ] });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: 'https://logs.example/signed' } });
    return new Response(log + 'unrelated private transcript');
  });
  assert.match(calls[0].url, /runs\/1\/attempts\/2\/jobs/);
  assert.equal(calls[2].options.headers, undefined);
  assert.equal(result.attempts[0].elapsed_seconds, 60);
  assert.equal(result.totals.input_tokens, 100);
  assert.doesNotMatch(JSON.stringify(result), /private transcript|test-placeholder|signed/);
});

test('API or log failures preserve missing measurements rather than fabricating zero cost', async () => {
  const result = await collectUsage(env, async () => new Response('', { status: 403 }));
  assert.equal(result.coverage, 'unavailable');
  assert.equal(result.totals, null);
});
