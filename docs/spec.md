# SpecSync Specification

This is the specification for SpecSync itself. SpecSync runs against this file on
every pull request to this repository, so it doubles as a live example.

## Inputs

### SS-1: Spec formats

SpecSync accepts spec documents in Markdown (`.md`, `.markdown`, `.mdx`), plain
text, HTML, Word (`.docx`) and PDF. Word heading styles and PDF headings (lines
set in a larger font, or numbered like `2.1 Title`) must be preserved so that
sections can be split into requirements. Unsupported formats fail with an error
naming the supported ones.

### SS-2: Requirement extraction

Each heading section with body text becomes one requirement. A single leading
level-1 heading is treated as the document title. Explicit ids in headings such
as `REQ-12: Login` or `[AUTH-3] Logout` are used as requirement ids; other ids are
slugs of the heading, de-duplicated, with section numbers left out. Sections named
"Out of scope", "Non-goals", "Glossary", "References", "Changelog" or "Appendix"
are skipped together with their subsections.

### SS-3: Atomic extraction mode

With `extraction: "llm"`, each section is split by the model into atomic
requirements with ids `<section-id>.<n>`, and the split is cached.

### SS-4: Source file selection

Source files are found under the configured repo directory. Exclusions
(`node_modules`, `dist`, `build`, `vendor`, tests, minified files and anything
in `exclude`) are matched relative to the repo root, never against the absolute
path. The repo's `.gitignore` and `.specsyncignore` files are honoured, including
nested ones in subdirectories. Files over 1 MB, binary files and minified files
are skipped.

### SS-5: Code chunking

Code is split at declaration boundaries with tree-sitter for JavaScript,
TypeScript, Python, Go, Java, Ruby, Rust, C#, PHP and C/C++. Doc comments
directly above a declaration belong to its chunk. Declarations longer than 150
lines are split into their members. Code between declarations, such as route
registrations, is kept as module chunks. Other languages fall back to
overlapping 60-line windows.

### SS-6: Public surface detection

Each declaration is marked public or private using the language's own rules:
`export` and CommonJS exports in JavaScript and TypeScript, capitalised names in
Go, `public` in Java and C#, `pub` in Rust, and no leading underscore in Python.

## Analysis

### SS-7: Retrieval

For each requirement, candidate code is found by combining embedding similarity
and BM25 keyword ranking with reciprocal-rank fusion. A requirement that lists
several behaviours is also searched once per list item, and gets a larger
candidate set.

### SS-8: Verdicts

Each requirement gets one of four verdicts: implemented, partial, missing, or
not-verifiable (cannot be judged from code). The model must cite evidence by the
labels of the chunks it was shown; citations of chunks that were not shown are
dropped, and a coverage claim with no valid evidence is downgraded to a
low-confidence partial.

### SS-9: Candidate budget

Code shown to the model per requirement stays within a token budget. When a
chunk is too long, its head and tail are kept and the omitted middle is marked
explicitly with the number of omitted lines; code is never cut silently.

### SS-10: Provider failures

Rate limits, timeouts and server errors are retried with exponential backoff and
jitter, honouring `Retry-After`. A requirement whose call still fails is
reported with an `error` verdict, never as a gap, and the run is marked
incomplete. Authentication and unknown-model errors stop the whole run with a
clear message.

### SS-11: Caching

Embeddings and verdicts are cached on disk, keyed by a hash of everything that
affects them: model, prompt version, requirement text and the content of the
candidate code. Re-running on unchanged inputs makes no model calls. Entries
unused for 30 days are dropped.

### SS-12: Budgets and dry runs

`--dry-run` reports how many model calls and roughly how many input tokens a run
needs without calling the model. A configured budget (`maxLlmCalls`,
`maxInputTokens`) aborts the run before any call when it would be exceeded.

## Results

### SS-13: Coverage score

The coverage score is `(implemented + 0.5 × partial) / checked × 100`, rounded,
where not-verifiable and errored requirements are excluded from `checked`.

### SS-14: Unmapped public code

The report lists public declarations that no implemented or partial requirement
cites as evidence, up to a configurable limit, with the total number of public
symbols.

### SS-15: Report formats

Reports can be printed as coloured terminal text, Markdown, JSON and SARIF 2.1.0.
SARIF results point at the requirement's line in the spec file. Markdown links
evidence to source lines when a link base URL is given.

### SS-16: Comparison with earlier runs

Each run is appended to a local history file. A run is compared with an explicit
baseline report or the previous run for the same spec and repo, and the report
lists regressions, improvements, and added or removed requirements.

### SS-17: CI checks

`specsync check` exits 0 when thresholds pass, 1 when they fail (score below
`minScore`, or any of the configured `failOn` conditions: missing, partial,
regression) and 2 when the run could not complete.

### SS-18: Pull request comments

The GitHub Action analyzes both the base and head commits of a pull request,
sharing one cache, and posts a single comment that it updates on later pushes.
When the token cannot comment (for example on pull requests from forks) the
action warns and the report remains in the job summary.

## Operations

### SS-19: Providers

Gemini, Anthropic, OpenAI, Ollama and any OpenAI-compatible endpoint are
supported. In auto mode the first available is used, in that order. The model can
be set per run.

### SS-20: Documentation

Every CLI flag and config option is documented in the README.

### SS-21: Embedding choice

Users choose where embeddings run: a local model downloaded automatically on
first use, the Gemini or OpenAI embedding API, or any OpenAI-compatible endpoint,
from the config file or `--embeddings`. In the default `auto` mode the local model
is used, and if it cannot be loaded SpecSync switches to an embedding API for
which a key is set, before any vectors are produced, so one run never mixes
vectors from two models.
