import assert from 'node:assert/strict';
import test from 'node:test';
import { recordDisposition, summarize } from './review-dispositions.mjs';

const empty = { schema_version: 1, entries: [] };
const report = { schema_version: 1, repository: 'example/repo', pr: 1, base: 'base', head: 'head',
  run_id: '1', run_attempt: '1', status: 'blocked', findings: [{ id: 'finding' }], usage: null };
const entry = { finding_id: 'finding', status: 'accepted', issue_key: 'identity-binding',
  reviewer: 'reviewer', evidence: 'Fixed in commit abc; regression passed.' };

test('records exact-revision evidence and rejects unknown or unsupported dispositions', () => {
  const ledger = recordDisposition(report, empty, entry);
  assert.equal(ledger.entries[0].head, 'head');
  assert.throws(() => recordDisposition(report, empty, { ...entry, finding_id: 'unknown' }));
  assert.throws(() => recordDisposition(report, empty, { ...entry, status: 'approved-by-model' }));
  assert.throws(() => recordDisposition(report, empty, { ...entry, evidence: '' }));
  assert.equal(report.status, 'blocked');
});

test('retriage replaces the same occurrence and stale revision evidence is not applied', () => {
  const ledger = recordDisposition(report, empty, entry);
  const replacement = recordDisposition(report, ledger, { ...entry, status: 'false_positive' });
  assert.equal(replacement.entries.length, 1);
  assert.equal(summarize([report], replacement).dispositions.false_positive, 1);
  assert.equal(summarize([{ ...report, head: 'new-head' }], ledger).dispositions.untriaged, 1);
});

test('deduplicates downloads and logical accepted issues without hiding repeated report occurrences', () => {
  const second = { ...report, run_id: '2', findings: [{ id: 'another-finding' }] };
  const ledger = recordDisposition(second, recordDisposition(report, empty, entry),
    { ...entry, finding_id: 'another-finding' });
  const totals = summarize([report, report, second], ledger);
  assert.equal(totals.runs, 2);
  assert.equal(totals.prs, 1);
  assert.equal(totals.finding_occurrences, 2);
  assert.equal(totals.accepted_distinct_issues, 1);
  assert.equal(totals.runs_without_token_totals, 2);
  assert.equal(totals.measured_tokens, null);
});

test('sums measured token subsets and keeps unknown runs visible', () => {
  const measured = { ...report, usage: { totals: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } };
  const totals = summarize([measured, { ...report, run_id: '2' }], empty);
  assert.deepEqual(totals.measured_tokens, measured.usage.totals);
  assert.equal(totals.runs_without_token_totals, 1);
});
