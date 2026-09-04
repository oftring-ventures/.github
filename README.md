# Oftring Ventures GitHub configuration

This repository hosts reusable GitHub Actions workflows for Oftring Ventures.

## Codex pull request review

`codex-pr-review.yml` runs a read-only Codex review on internal pull requests. It uses `gpt-5.3-codex` with `medium` reasoning effort and blocks only high-confidence P0/P1 findings. Callers must inherit the selected-repository `OPENAI_API_KEY` organization secret.

Fork pull requests are intentionally skipped because GitHub withholds Actions secrets from untrusted fork code. Review these manually or through the native Codex GitHub review surface.

## Review report contract

`scripts/review-report.mjs` validates structured findings and produces a JSON
report with exact repository, PR, base/head, run identity, model, and gate outcome.
Missing or malformed review results fail closed. Warnings remain visible in
passing reports; a fork skip is recorded separately from a completed review.
Finding IDs identify a report on an exact revision, not deduplicated defects.
Dispositions start as `untriaged`; model-supplied dispositions are discarded.
Unknown usage is `null`, never zero. The workflow integration is a separate layer.

Run the dependency-free tooling tests with `node --test scripts/*.test.mjs`.

## Measured usage

`scripts/review-usage.mjs` reads completed review-job logs for the exact workflow
attempt using `actions: read`. It extracts only Codex JSONL `turn.completed`
token counts and execution metadata; transcripts and signed log URLs are not
saved. Cached input is a subset of input, not additional tokens. Failed or
interrupted turns may lack usage, so totals are explicitly partial and are not
a bill. API/log failures leave unknown measurements null without changing the
review verdict. The caller should invoke the reusable review once per workflow.
