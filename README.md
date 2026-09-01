# Oftring Ventures GitHub configuration

This repository hosts reusable GitHub Actions workflows for Oftring Ventures.

## Codex pull request review

`codex-pr-review.yml` runs a read-only Codex review on internal pull requests. It uses `gpt-5.3-codex` with `medium` reasoning effort and blocks only high-confidence P0/P1 findings. Callers must inherit the selected-repository `OPENAI_API_KEY` organization secret.

Fork pull requests are intentionally skipped because GitHub withholds Actions secrets from untrusted fork code. Review these manually or through the native Codex GitHub review surface.
