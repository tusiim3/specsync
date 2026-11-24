# Contributing

## Setup

Requires Node.js 22.13 or newer.

```bash
npm ci
npm test            # vitest, fully offline: scripted model and hashed embeddings
npm run lint
npm run typecheck
npm run build
node dist/bin.js run --spec test/fixtures/todo-api/docs/spec.md --repo test/fixtures/todo-api
```

`test/fixtures/todo-api` is a small TypeScript, Python and Go app with a spec and known answers (`expected.json`); the golden test runs the whole pipeline on it.

## Measuring accuracy

These scripts call real models, so they need a provider key.

```bash
npm run eval                                    # verdicts vs eval/cases.json
npm run eval -- --model gemini-3.5-flash        # try another model
npm run eval:retrieval -- --embeddings local    # retrieval only, no LLM calls
```

The Express case needs `git clone --depth 1 https://github.com/expressjs/express demo/target-repo`. Please include eval results in pull requests that change prompts, retrieval or defaults.

## README images

`node scripts/render-assets.mjs <report.json>` regenerates the banner and terminal images in `.github/assets` from the HTML in `.github/assets/src`; the terminal image is drawn from a real JSON report.

## Releasing

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`, through a pull request to `master`.
2. On GitHub, open **Releases → Draft a new release**, create the tag `v<version>` targeting `master`, and publish.

The release workflow checks that the tag matches `package.json`, runs the checks, publishes `@tusiim3/specsync` to npm (trusted publishing, or the `NPM_TOKEN` secret) and moves the major tag (`v1`) so `uses: tusiim3/specsync@v1` picks up the release.
