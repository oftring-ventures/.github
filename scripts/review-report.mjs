import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
export const blocks = (finding) => finding.priority <= 1 && finding.confidence >= 0.85;

export function parseReview(raw) {
  const review = JSON.parse(raw);
  if (!review || !Array.isArray(review.findings) || review.findings.length > 100 ||
      typeof review.summary !== 'string') throw new Error('Invalid review document');
  return {
    summary: review.summary.slice(0, 20000),
    findings: review.findings.map((f) => {
      if (!f || !integer(f.priority, 0, 3) || !Number.isFinite(f.confidence) ||
          f.confidence < 0 || f.confidence > 1 || !text(f.title, 120) ||
          !text(f.body, 20000) || !text(f.path, 1000) ||
          f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').includes('..') ||
          !integer(f.start_line, 1, 10000000) || !integer(f.end_line, f.start_line, 10000000)) {
        throw new Error('Invalid review finding');
      }
      // Persist only the documented fields, never arbitrary model-supplied metadata.
      return Object.fromEntries(['priority', 'confidence', 'title', 'body', 'path', 'start_line', 'end_line']
        .map((key) => [key, f[key]]));
    }),
  };
}

export function makeReport({ repository, pr, base, head, runId, runAttempt, internal, hasKey, outcome, result }) {
  const report = { schema_version: 1, repository, pr, base, head, run_id: runId,
    run_attempt: runAttempt, model: 'gpt-5.3-codex', effort: 'medium',
    status: 'execution_failure', findings: [], usage: null };
  if (!internal) return { ...report, status: 'fork_skipped' };
  if (!hasKey) return { ...report, status: 'configuration_failure' };
  if (outcome !== 'success') return report;
  try {
    const review = parseReview(result);
    report.summary = review.summary;
    report.findings = review.findings.map((finding) => ({
      ...finding,
      id: createHash('sha256').update(JSON.stringify([repository, pr, base, head, finding])).digest('hex'),
      disposition: 'untriaged',
    }));
    report.status = report.findings.some(blocks) ? 'blocked' : 'passed';
  } catch {
    report.status = 'invalid_output';
  }
  return report;
}

export const allowed = (report) => ['passed', 'fork_skipped'].includes(report.status);
const escapeData = (s) => String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (s) => escapeData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
export function annotation(f) {
  const message = `[P${f.priority}, ${Math.round(f.confidence * 100)}%] ${f.title}: ${f.body}`;
  return `::${blocks(f) ? 'error' : 'warning'} file=${escapeProperty(f.path)},line=${f.start_line},endLine=${f.end_line},title=${escapeProperty(f.title)}::${escapeData(message)}`;
}

export function emitReport(report, env = process.env) {
  writeFileSync(env.REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  appendFileSync(env.GITHUB_OUTPUT, `allowed=${allowed(report)}\nstatus=${report.status}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    `### Codex review: ${report.status}\n\nFindings: ${report.findings.length}; blockers: ${report.findings.filter(blocks).length}.\n\n` +
    'The JSON artifact contains review identity and untriaged finding IDs. A pass may include warnings.\n');
  for (const f of report.findings) console.log(annotation(f));
  if (!allowed(report) && report.status !== 'blocked') {
    console.log(`::error title=Codex ${report.status}::Review unavailable; this is not a code finding. See the JSON artifact and review job.`);
  }
}

export function reportFromEnvironment(env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr?.number || !pr.base?.sha || !pr.head?.sha) throw new Error('Pull request identity missing');
  return makeReport({ repository: env.GITHUB_REPOSITORY, pr: pr.number, base: pr.base.sha, head: pr.head.sha,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    internal: pr.head.repo?.full_name === env.GITHUB_REPOSITORY,
    hasKey: env.HAS_OPENAI_KEY === 'true', outcome: env.REVIEW_OUTCOME, result: env.REVIEW_RESULT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  emitReport(reportFromEnvironment());
}
