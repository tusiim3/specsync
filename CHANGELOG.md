# Changelog

## 1.0.0 (unreleased)

First release meant for real projects.

### Added
- `init`, `check` and `diff` commands; `run` gains `--dry-run`, `--verbose`, `--baseline`, `--link-base` and JSON, SARIF and compact PR-comment outputs.
- GitHub Action that compares a pull request with its base and keeps one updated comment.
- Anthropic, OpenAI-compatible and configurable models for every provider; optional API embeddings.
- tree-sitter chunking for TypeScript, JavaScript, Python, Go, Java, Ruby, Rust, C#, PHP and C/C++.
- Hybrid BM25 + embedding retrieval with per-item queries.
- Partial and not-verifiable verdicts, validated evidence, unmapped public code.
- Content-hash cache, run history, budgets, `requestsPerMinute` pacing.
- Word and PDF specs keep their headings; explicit requirement ids; ignored sections.
- Config file with JSON schema, `.env` loading, nested `.gitignore`/`.specsyncignore`.
- Test suite, eval harness, CI.

### Changed
- License is now Apache 2.0.
- The score counts partial as half and leaves out not-verifiable and failed requirements.
- History moved from `drift-map.json` to `.specsync/history.json`.

### Fixed
- Provider errors were reported as gaps.
- The model only saw 200 characters of each code chunk.
- PDF and Word specs produced no requirements.
- Gemini requests had no working timeout.
- Covered requirements showed as slugs in reports.
- Exclusions matched anywhere in the absolute path.
