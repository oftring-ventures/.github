import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

test('report CLI preserves verdicts and emits artifacts when usage retrieval fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-report-test-'));
  const server = createServer((req, res) => { res.writeHead(403); res.end('unavailable'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 3,
      base: { sha: 'base' }, head: { sha: 'head', repo: { full_name: 'example/repo' } } } }));
    for (const [outcome, hasKey, result, expected] of [
      ['success', 'true', '{"summary":"ok","findings":[]}', 'passed'],
      ['failure', 'true', '{"summary":"old","findings":[]}', 'execution_failure'],
      ['', 'false', '', 'configuration_failure'],
      ['success', 'true', '{}', 'invalid_output'],
    ]) {
      const reportPath = join(dir, 'report.json');
      const outputPath = join(dir, 'output');
      await writeFile(outputPath, '');
      await promisify(execFile)(process.execPath, ['scripts/review-report.mjs'], { env: {
        PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'example/repo',
        GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', HAS_OPENAI_KEY: hasKey,
        REVIEW_OUTCOME: outcome, REVIEW_RESULT: result, REPORT_PATH: reportPath,
        GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_TOKEN: 'placeholder',
      } });
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.status, expected);
      assert.equal(report.base, 'base');
      assert.equal(report.head, 'head');
      assert.equal(report.usage.totals, null);
      assert.match(await readFile(outputPath, 'utf8'), new RegExp(`allowed=${expected === 'passed'}\\n`));
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
