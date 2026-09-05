import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectUsage } from './review-usage.mjs';

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
  const explicit = env.REVIEW_PR_NUMBER && env.REVIEW_BASE_SHA && env.REVIEW_HEAD_SHA;
  const pull = explicit ? null : JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
  const pr = env.REVIEW_PR_NUMBER || pull?.number;
  const base = env.REVIEW_BASE_SHA || pull?.base?.sha;
  const head = env.REVIEW_HEAD_SHA || pull?.head?.sha;
  const headRepository = env.REVIEW_HEAD_REPOSITORY || pull?.head?.repo?.full_name;
  if (!pr || !base || !head || (explicit && !headRepository)) {
    throw new Error('Pull request identity missing');
  }
  return makeReport({ repository: env.GITHUB_REPOSITORY, pr: Number(pr), base, head,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    internal: headRepository === env.GITHUB_REPOSITORY,
    hasKey: env.HAS_OPENAI_KEY === 'true', outcome: env.REVIEW_OUTCOME, result: env.REVIEW_RESULT });
}

export async function updateAdmittedCheck(report, env = process.env) {
  if (!env.REVIEW_CHECK_RUN_ID) return;
  const annotations = report.findings.slice(0, 50).map((finding) => ({
    path: finding.path,
    start_line: finding.start_line,
    end_line: finding.end_line,
    annotation_level: blocks(finding) ? 'failure' : 'warning',
    title: finding.title,
    message: `[P${finding.priority}, ${Math.round(finding.confidence * 100)}%] ${finding.body}`,
  }));
  const response = await fetch(
    `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/check-runs/${env.REVIEW_CHECK_RUN_ID}`,
    {
      method: 'PATCH',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ status: 'completed', conclusion: allowed(report) ? 'success' : 'failure',
        completed_at: new Date().toISOString(),
        details_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        output: { title: `Codex review: ${report.status}`,
          summary: `${report.summary || 'Review did not produce a summary.'}\n\nFindings: ${report.findings.length}; blocking: ${report.findings.filter(blocks).length}.`,
          annotations } }),
    });
  if (!response.ok) throw new Error(`Unable to update admitted Codex check: ${response.status} ${await response.text()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = reportFromEnvironment();
  report.usage = await collectUsage();
  emitReport(report);
  await updateAdmittedCheck(report);
}
