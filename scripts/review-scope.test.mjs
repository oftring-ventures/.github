import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-pr-review.yml", import.meta.url),
  "utf8",
);
// Execute the actual trusted inline step, not a separate test implementation.
const step = workflow
  .split("      - name: Prepare introduced-change review scope\n")[1]
  .split("      - name: Run Codex review\n")[0];
const script = step
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
  .join("\n");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Review fixture");
  git("config", "user.email", "review@example.invalid");
  const commit = (message) => {
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(root, "baseline.txt"), "retained\n");
  writeFileSync(join(root, "delete-me.txt"), "original\n");
  const base = commit("base");
  const run = (target, head) => {
    const output = join(root, "scope-output");
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_SHA: target,
        HEAD_SHA: head,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: output,
      },
    });
    return {
      ...result,
      output: () => readFileSync(output, "utf8"),
      patch: () => readFileSync(join(root, "review-pr.patch"), "utf8"),
    };
  };
  return { root, git, commit, base, run };
}

test("divergent target additions are excluded while a genuine PR deletion is retained", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "target");
  writeFileSync(
    join(f.root, "admission-migration.sql"),
    "-- target-only authorization\n",
  );
  writeFileSync(join(f.root, "baseline.txt"), "target-only test guard\n");
  const target = f.commit("target admission");
  f.git("checkout", "-b", "feature", f.base);
  writeFileSync(join(f.root, "outbox.sql"), "-- introduced storage\n");
  rmSync(join(f.root, "delete-me.txt"));
  const head = f.commit("outbox and real deletion");
  const result = f.run(target, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output(), new RegExp(`merge_base=${f.base}\\n`));
  assert.match(result.patch(), /outbox\.sql/);
  assert.match(result.patch(), /deleted file mode/);
  assert.match(result.patch(), /delete-me\.txt/);
  assert.doesNotMatch(
    result.patch(),
    /admission-migration|target-only|baseline\.txt/,
  );
});

test("an ancestor target remains the patch origin", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "baseline.txt"), "feature\n");
  const head = f.commit("feature");
  const result = f.run(f.base, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output(), new RegExp(`merge_base=${f.base}\\n`));
  assert.match(result.patch(), /\+feature/);
});

test("invalid, missing and mismatched checkout identities fail closed", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "baseline.txt"), "feature\n");
  const head = f.commit("feature");
  for (const [target, expected] of [
    ["main", head],
    ["f".repeat(40), head],
    [f.base, f.base],
  ]) {
    assert.notEqual(f.run(target, expected).status, 0);
  }
});

test("unrelated histories fail without a fabricated merge base", (t) => {
  const f = fixture(t);
  f.git("checkout", "--orphan", "unrelated");
  const head = f.commit("unrelated");
  assert.notEqual(f.run(f.base, head).status, 0);
});

test("multiple merge bases require explicit resolution", (t) => {
  const f = fixture(t);
  const tree = f.git("rev-parse", `${f.base}^{tree}`);
  const left = f.git("commit-tree", tree, "-p", f.base, "-m", "left");
  const right = f.git("commit-tree", tree, "-p", f.base, "-m", "right");
  const target = f.git(
    "commit-tree",
    tree,
    "-p",
    left,
    "-p",
    right,
    "-m",
    "target",
  );
  const head = f.git(
    "commit-tree",
    tree,
    "-p",
    right,
    "-p",
    left,
    "-m",
    "head",
  );
  f.git("checkout", "--detach", head);
  assert.equal(
    f.git("merge-base", "--all", target, head).split("\n").length,
    2,
  );
  assert.notEqual(f.run(target, head).status, 0);
});

test("review consumes the prepared scope and preserves separate target identity", () => {
  assert.match(workflow, /steps\.review_scope\.outputs\.patch_path/);
  assert.match(workflow, /steps\.review_scope\.outputs\.merge_base/);
  assert.match(workflow, /EXPECTED_BASE_SHA: \$\{\{ inputs\.base_sha \}\}/);
  assert.match(workflow, /REVIEW_BASE_SHA: \$\{\{ inputs\.base_sha \}\}/);
  assert.ok(
    workflow.indexOf("Prepare introduced-change review scope") <
      workflow.indexOf("      - name: Run Codex review"),
  );
});
