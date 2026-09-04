import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const statuses = ['accepted', 'false_positive', 'partial', 'duplicate', 'deferred'];
const nonempty = (value) => typeof value === 'string' && value.trim() && value.length <= 4000;
const key = (entry) => JSON.stringify([entry.repository, entry.pr, entry.finding_id]);

export function validateLedger(ledger) {
  if (ledger?.schema_version !== 1 || !Array.isArray(ledger.entries)) throw new Error('Invalid ledger');
  const seen = new Set();
  for (const entry of ledger.entries) {
    if (!entry || !Number.isSafeInteger(entry.pr) || entry.pr < 1 ||
        !['repository', 'finding_id', 'base', 'head', 'issue_key', 'reviewer', 'evidence'].every((k) => nonempty(entry[k])) ||
        !statuses.includes(entry.status) || seen.has(key(entry))) throw new Error('Invalid disposition');
    seen.add(key(entry));
  }
  return ledger;
}

export function recordDisposition(report, ledger, entry) {
  validateLedger(ledger);
  if (report?.schema_version !== 1 || !report.findings?.some((f) => f.id === entry.finding_id)) {
    throw new Error('Finding is absent from this report');
  }
  const bound = { repository: report.repository, pr: report.pr, base: report.base, head: report.head,
    finding_id: entry.finding_id, status: entry.status, issue_key: entry.issue_key,
    reviewer: entry.reviewer, evidence: entry.evidence };
  return validateLedger({ schema_version: 1,
    entries: [...ledger.entries.filter((old) => key(old) !== key(bound)), bound] });
}

export function summarize(reports, ledger) {
  validateLedger(ledger);
  const dispositions = new Map(ledger.entries.map((entry) => [key(entry), entry]));
  const counts = { runs: 0, prs: 0, statuses: {}, finding_occurrences: 0, dispositions: {},
    accepted_distinct_issues: 0, measured_tokens: null, runs_without_token_totals: 0,
    token_coverage: 'completed_turns_only_not_a_bill' };
  const seen = new Set();
  const prs = new Set();
  const accepted = new Set();
  for (const report of reports) {
    if (report?.schema_version !== 1 || !report.repository || !report.run_id || !report.run_attempt ||
        !Array.isArray(report.findings)) throw new Error('Invalid report');
    const run = JSON.stringify([report.repository, report.run_id, report.run_attempt]);
    if (seen.has(run)) continue;
    seen.add(run);
    prs.add(JSON.stringify([report.repository, report.pr]));
    counts.runs++;
    counts.statuses[report.status] = (counts.statuses[report.status] ?? 0) + 1;
    for (const finding of report.findings) {
      counts.finding_occurrences++;
      const entry = dispositions.get(key({ ...report, finding_id: finding.id }));
      const status = entry?.base === report.base && entry?.head === report.head ? entry.status : 'untriaged';
      counts.dispositions[status] = (counts.dispositions[status] ?? 0) + 1;
      if (status === 'accepted') accepted.add(JSON.stringify([report.repository, entry.issue_key]));
    }
    const tokens = report.usage?.totals;
    const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
    if (tokens && fields.every((k) => Number.isSafeInteger(tokens[k]) && tokens[k] >= 0) &&
        tokens.cached_input_tokens <= tokens.input_tokens) {
      counts.measured_tokens ??= Object.fromEntries(fields.map((k) => [k, 0]));
      for (const k of fields) counts.measured_tokens[k] += tokens[k];
    } else counts.runs_without_token_totals++;
  }
  counts.prs = prs.size;
  counts.accepted_distinct_issues = accepted.size;
  return counts;
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ledgerPath, ...args] = process.argv.slice(2);
  if (command === 'record' && args.length === 6) {
    const [reportPath, finding_id, status, issue_key, reviewer, evidence] = args;
    const ledger = recordDisposition(read(reportPath), read(ledgerPath), { finding_id, status, issue_key, reviewer, evidence });
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
    console.log('Disposition recorded; this does not change any CI verdict.');
  } else if (command === 'summarize' && args.length > 0) {
    console.log(JSON.stringify(summarize(args.map(read), read(ledgerPath)), null, 2));
  } else {
    throw new Error('Usage: record LEDGER REPORT FINDING STATUS ISSUE_KEY REVIEWER EVIDENCE | summarize LEDGER REPORT...');
  }
}
