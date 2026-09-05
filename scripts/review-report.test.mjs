import assert from 'node:assert/strict';
import test from 'node:test';
import { allowed, annotation, makeReport, parseReview, reportFromEnvironment,
  updateAdmittedCheck } from './review-report.mjs';

const finding = { priority: 1, confidence: 0.85, title: 'Bind the actor', body: 'The row admits the wrong actor.',
  path: 'db/migration.sql', start_line: 3, end_line: 5 };
const context = { repository: 'example/repo', pr: 1, base: 'base', head: 'head', runId: '10',
  runAttempt: '1', internal: true, hasKey: true, outcome: 'success' };
const review = (findings) => JSON.stringify({ findings, summary: 'Review complete.' });

test('only high-confidence P0/P1 findings block; warnings survive in passing reports', () => {
  for (const priority of [0, 1, 2, 3]) {
    for (const confidence of [0.84, 0.85, 1]) {
      const report = makeReport({ ...context, result: review([{ ...finding, priority, confidence }]) });
      assert.equal(allowed(report), !(priority <= 1 && confidence >= 0.85));
      assert.equal(report.findings.length, 1);
    }
  }
  assert.equal(makeReport({ ...context, result: review([]) }).status, 'passed');
});

test('malformed output and execution/configuration failures fail closed', () => {
  for (const result of ['', 'null', '{}', '{"summary":"ok"}', review([{ ...finding, priority: '1' }]),
    review([{ ...finding, confidence: '0.99' }]), review([{ ...finding, end_line: 2 }]),
    review([{ ...finding, path: '../outside' }]), review([{ ...finding, path: '/outside' }])]) {
    const report = makeReport({ ...context, result });
    assert.equal(report.status, 'invalid_output');
    assert.equal(allowed(report), false);
  }
  assert.equal(makeReport({ ...context, hasKey: false }).status, 'configuration_failure');
  assert.equal(makeReport({ ...context, outcome: 'failure', result: review([]) }).status, 'execution_failure');
  assert.equal(makeReport({ ...context, internal: false, hasKey: false }).status, 'fork_skipped');
});

test('finding IDs bind exact base/head and do not trust model dispositions', () => {
  const result = review([{ ...finding, disposition: 'invalid', secret: 'not retained' }]);
  const a = makeReport({ ...context, result });
  const b = makeReport({ ...context, result, runId: '11' });
  const c = makeReport({ ...context, result, base: 'different-base' });
  assert.equal(a.findings[0].id, b.findings[0].id);
  assert.notEqual(a.findings[0].id, c.findings[0].id);
  assert.equal(a.findings[0].disposition, 'untriaged');
  assert.equal(a.findings[0].secret, undefined);
  assert.equal(a.usage, null);
});

test('annotations cannot inject workflow commands or property delimiters', () => {
  const line = annotation({ ...finding, title: 'x,y:z%\r\n::error::spoof', body: 'text\n::error::spoof',
    path: 'file,name.sql' });
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /file=file%2Cname.sql/);
  assert.match(line, /title=x%2Cy%3Az%25%0D%0A/);
  assert.match(line, /text%0A::error::spoof/);
  assert.equal(parseReview(review([finding])).findings[0].path, 'db/migration.sql');
});

test('explicit admitted-review identity overrides a non-PR event', () => {
  const env = {
    GITHUB_EVENT_PATH: new URL('../README.md', import.meta.url),
    GITHUB_REPOSITORY: 'example/repo', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '7', REVIEW_BASE_SHA: 'base', REVIEW_HEAD_SHA: 'head',
    REVIEW_HEAD_REPOSITORY: 'example/repo', HAS_OPENAI_KEY: 'true',
    REVIEW_OUTCOME: 'success', REVIEW_RESULT: review([]),
  };
  const report = reportFromEnvironment(env);
  assert.equal(report.pr, 7);
  assert.equal(report.status, 'passed');
});

test('updates the controller-created check with findings', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{}', { status: 200 });
  };
  try {
    const report = makeReport({ ...context, result: review([finding]) });
    await updateAdmittedCheck(report, {
      REVIEW_CHECK_RUN_ID: '99', GITHUB_API_URL: 'https://api.github.test',
      GITHUB_REPOSITORY: 'example/repo', GITHUB_TOKEN: 'placeholder',
      GITHUB_SERVER_URL: 'https://github.test', GITHUB_RUN_ID: '10',
    });
    assert.equal(request.url, 'https://api.github.test/repos/example/repo/check-runs/99');
    const body = JSON.parse(request.options.body);
    assert.equal(body.conclusion, 'failure');
    assert.equal(body.output.annotations[0].annotation_level, 'failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
