// Read only completed review-job logs. Never retain transcripts, credentials, or signed log URLs.
const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
export function parseUsageLog(log) {
  const usage = Object.fromEntries(tokenFields.map((key) => [key, 0]));
  let completedTurns = 0;
  let failedTurns = 0;
  let rateLimited = false;
  for (const line of log.split('\n')) {
    const payload = line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '');
    if (!payload.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event?.type === 'turn.failed') failedTurns++;
    if (['turn.failed', 'error'].includes(event?.type)) {
      rateLimited ||= /rate.?limit|\b429\b/i.test(event.message ?? event.error?.message ?? '');
    }
    if (event?.type !== 'turn.completed') continue;
    const u = event.usage;
    if (!u || !tokenFields.every((key) => Number.isSafeInteger(u[key]) && u[key] >= 0) ||
        u.cached_input_tokens > u.input_tokens) continue;
    completedTurns++;
    for (const key of tokenFields) usage[key] += u[key];
  }
  return { usage: completedTurns ? usage : null, completed_turns: completedTurns,
    failed_turns: failedTurns, rate_limited: rateLimited };
}

async function boundedText(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 20 * 1024 * 1024) throw new Error('Log exceeds measurement limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function collectUsage(env = process.env, request = fetch) {
  const root = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' };
  const options = () => ({ headers, signal: AbortSignal.timeout(30000) });
  try {
    const jobs = [];
    for (let page = 1; ; page++) {
      if (page > 10) throw new Error('Job listing exceeds measurement limit');
      const response = await request(`${root}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`, options());
      if (!response.ok) throw new Error('Jobs unavailable');
      const data = await response.json();
      if (!Array.isArray(data.jobs)) throw new Error('Invalid job listing');
      jobs.push(...data.jobs.filter((job) => /(?:^|\/ )Codex review(?: retry)?$/.test(job.name)));
      if (page * 100 >= data.total_count) break;
    }
    if (!jobs.length) throw new Error('Review jobs unavailable');
    const attempts = [];
    for (const job of jobs.filter((job) => job.conclusion !== 'skipped')) {
      const attempt = { job_id: job.id, conclusion: job.conclusion, usage: null, measurement: 'unavailable' };
      const duration = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      attempt.elapsed_seconds = Number.isFinite(duration) && duration >= 0 ? duration : null;
      try {
        let response = await request(`${root}/actions/jobs/${job.id}/logs`, { ...options(), redirect: 'manual' });
        if (response.status === 302) {
          const location = response.headers.get('location');
          if (!location?.startsWith('https://')) throw new Error('Invalid log redirect');
          // Signed log storage URLs must never receive the GitHub bearer token.
          response = await request(location, { signal: AbortSignal.timeout(30000) });
        }
        if (!response.ok) throw new Error('Logs unavailable');
        Object.assign(attempt, parseUsageLog(await boundedText(response)));
        attempt.measurement = attempt.usage ? 'completed_turns_only' : 'no_usage_events';
      } catch { /* Report missing data honestly; telemetry must not override the gate. */ }
      attempts.push(attempt);
    }
    const measured = attempts.filter((attempt) => attempt.usage);
    return { source: 'codex_jsonl', coverage: 'completed_turns_only', attempts,
      totals: measured.length ? Object.fromEntries(tokenFields.map((key) =>
        [key, measured.reduce((sum, attempt) => sum + attempt.usage[key], 0)])) : null };
  } catch {
    return { source: 'codex_jsonl', coverage: 'unavailable', attempts: [], totals: null };
  }
}
