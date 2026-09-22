import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-pr-review.yml", import.meta.url),
  "utf8",
);

test("admitted review validates the complete same-repository PR identity", () => {
  assert.match(
    workflow,
    /test "\$EXPECTED_HEAD_REPOSITORY" = "\$GITHUB_REPOSITORY"/,
  );
  assert.match(
    workflow,
    /\.state, \.draft, \.base\.ref, \.base\.sha, \.head\.sha, \.head\.repo\.full_name/,
  );
  assert.match(
    workflow,
    /expected="open\s+false\s+\$\{EXPECTED_BASE_SHA\}\s+\$\{EXPECTED_HEAD_SHA\}\s+\$\{GITHUB_REPOSITORY\}"/,
  );
});

test("a stacked review is bound to its open parent PR's exact head", () => {
  assert.match(workflow, /if \[ "\$base_ref" != main \]; then/);
  assert.match(
    workflow,
    /-f head="\$\{GITHUB_REPOSITORY_OWNER\}:\$\{base_ref\}"/,
  );
  assert.match(
    workflow,
    /select\(\.head\.repo\.full_name == env\.GITHUB_REPOSITORY\) \| \.head\.sha\] \| @tsv/,
  );
  assert.match(workflow, /test "\$parent" = "\$EXPECTED_BASE_SHA"/);
});

test("only admitted reviews trust the controller workflow actor", () => {
  assert.match(workflow, /allow-bots: \$\{\{ inputs\.mode == 'pr' \}\}/);
  assert.match(workflow, /allow-bot-users: ["']dependabot\[bot\]["']/);
});
