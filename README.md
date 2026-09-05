# Oftring Ventures GitHub configuration

This repository hosts reusable GitHub Actions workflows for Oftring Ventures.

## Codex pull request review

`codex-pr-review.yml` runs a read-only Codex review on internal pull requests. It uses `gpt-5.3-codex` with `medium` reasoning effort and blocks only high-confidence P0/P1 findings. Callers must inherit the selected-repository `OPENAI_API_KEY` organization secret. Admission-aware callers can review a quiet PR head through explicit identity inputs and a controller-created check run. `merge_group` mode bridges that exact-head verdict without another model invocation on GitHub's synthetic commit.

Fork pull requests are intentionally skipped because GitHub withholds Actions secrets from untrusted fork code. Review these manually or through the native Codex GitHub review surface.

## Review report contract

`scripts/review-report.mjs` validates structured findings and produces a JSON
report with exact repository, PR, base/head, run identity, model, and gate outcome.
Missing or malformed review results fail closed. Warnings remain visible in
passing reports; a fork skip is recorded separately from a completed review.
Finding IDs identify a report on an exact revision, not deduplicated defects.
Dispositions start as `untriaged`; model-supplied dispositions are discarded.
Unknown usage is `null`, never zero.

Run the dependency-free tooling tests with `node --test scripts/*.test.mjs`.

## Measured usage

`scripts/review-usage.mjs` reads completed review-job logs for the exact workflow
attempt using `actions: read`. It extracts only Codex JSONL `turn.completed`
token counts and execution metadata; transcripts and signed log URLs are not
saved. Cached input is a subset of input, not additional tokens. Failed or
interrupted turns may lack usage, so totals are explicitly partial and are not
a bill. API/log failures leave unknown measurements null without changing the
review verdict. The caller should invoke the reusable review once per workflow.

## Finding dispositions and ROI

Keep a local/private ledger initialized as `{"schema_version":1,"entries":[]}`.
After investigating a finding, record its artifact ID, a stable human-assigned
logical issue key, reviewer, and evidence (fix/test/source reference):

```sh
node scripts/review-dispositions.mjs record ledger.json report.json FINDING_ID accepted identity-binding REVIEWER 'Fix commit and regression evidence'
node scripts/review-dispositions.mjs summarize ledger.json reports/*.json
```

Allowed dispositions are `accepted`, `false_positive`, `partial`, `duplicate`,
and `deferred`. Reuse an issue key across repeat reports of the same defect.
The summary counts distinct accepted issues separately from report occurrences,
deduplicates downloaded workflow attempts, and retains untriaged findings and
unknown usage. Evidence is bound to the report's exact repository/PR/base/head.
The ledger does not override CI or suppress future findings. Do not commit
private caller reports or ledgers into this public configuration repository.

## Workflow operation

Callers must grant `contents: read`, `actions: read`, and `checks: write`, inherit
the selected `OPENAI_API_KEY` secret, and pin the reusable workflow to a reviewed
commit. Admission-aware callers pass the PR/base/head identity, internal head
repository, mode, and queued check-run ID; legacy pull-request callers may keep
using event context.
The organization caller also uses an immutable pin. Validate a candidate
revision before advancing callers; a caller pin is not a substitute for review
and protection of changes to CI configuration itself.

Configuration is checked before checkout or CLI installation. Dependabot is
explicitly permitted as a bot, but requires a **Dependabot secret** named
`OPENAI_API_KEY`, separately from the Actions secret. Provision it through
GitHub's Dependabot secret settings using an appropriately scoped API key;
never place a key in a file, command argument, PR, or report. The preflight and
merge gate remain closed until it exists. Fork handling is unchanged. See
[GitHub's secret-access rules](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions#accessing-secrets).

The entire workflow cancels superseded PR runs. A 45–60 second initial delay
absorbs rapid pushes and spreads starts. A failed Codex execution gets one
retry after 60–75 seconds on a fresh runner because `drop-sudo` is irreversible.
Each Codex step is limited to eight minutes. A code finding is a successful
execution and is never retried to obtain a different verdict; setup failures
without a Codex execution are also not retried. Exhausted execution failures
remain blocking. This bounds attempts but is not an organization-wide rate cap.

The prompt requires concrete triggers and source evidence, checking database
constraints, inherited API security, and actual query semantics before claiming
a defect. Severity and confidence must follow demonstrated impact.

The separate gate runner checks out only the pinned reporting tools, never PR
code. It uploads `codex-review-RUN_ID-RUN_ATTEMPT` for 30 days before enforcing
the original blocking threshold. Download it with
`gh run download RUN_ID --name codex-review-RUN_ID-RUN_ATTEMPT --dir reports/RUN_ID`.
The report contains structured findings and measured usage; raw logs are not
uploaded. Workflow cancellation can prevent artifact creation, so Actions run
history remains the denominator for cancellations and draft skips.
