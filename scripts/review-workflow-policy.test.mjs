import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/codex-pr-review.yml', import.meta.url),
  'utf8',
);

test('admitted review validates the complete same-repository PR identity', () => {
  assert.match(workflow, /test "\$EXPECTED_HEAD_REPOSITORY" = "\$GITHUB_REPOSITORY"/);
  assert.match(
    workflow,
    /\.state, \.draft, \.base\.ref, \.base\.sha, \.head\.sha, \.head\.repo\.full_name/,
  );
  assert.match(
    workflow,
    /open\s+false\s+main\s+\$\{EXPECTED_BASE_SHA\}\s+\$\{EXPECTED_HEAD_SHA\}\s+\$\{GITHUB_REPOSITORY\}/,
  );
});
