# SpecSync

> Spec-to-code drift detection using parallel LLM subagents

---

## The Problem

Teams write a spec or PRD once. Code then drifts from it silently. Nobody notices
until a bug surfaces or an audit forces a reconciliation. There is no automated bridge
between the spec document and the codebase.

## The Solution

SpecSync ingests a spec document (Markdown, PDF, or DOCX) and a codebase, uses
**parallel LLM subagents** to map spec requirements to the code that implements them,
and produces a **drift report**:

- **Drift score** - a single 0-100 number representing the percentage of spec requirements that are covered
- **Gap list** - spec requirements with no implementing code found
- **Surplus list** - code behavior with no matching requirement

---

## Architecture

```
spec-document (MD/PDF/DOCX)
        |
        v
  [1] Ingestion Pipeline
      normalize -> section-split -> Requirement[]
        |
        v
  [2] Embedder  <----------------------------------------------+
      embed requirements                                        |
        |                                               [3] Code Chunker
        |                                                   chunk codebase
        |                                                   embed chunks
        |                                                       |
        +----------------------+--------------------------------+
                               v
                       [Similarity Search]
                       top-K candidates per requirement
                               |
                               v
                     [4] Orchestrator
                     Promise.all fan-out, one agent per requirement
                               |
          +--------------------+--------------------+
          v                    v                    v
      [Agent-1]           [Agent-2]            [Agent-N]   <- all run in parallel
          |                    |                    |
          +--------------------+--------------------+
                               |
                         CoverageResult[]
                               |
                               v
                    [5] Report Generator
                    drift score, gap list, surplus list
                               |
                    +----------+-----------+
                    v                      v
               CLI output           drift-report.md    drift-map.json
```

**Key design choices:**
- **Hybrid mapping**: embeddings shortlist candidates, LLM confirms coverage, bounded to N_requirements x 1 LLM calls rather than N x M
- **Model-agnostic**: auto-selects Gemini, OpenAI, or Ollama based on available env vars
- **Parallel subagents**: Promise.all fan-out with a visible per-agent log

---

## Prerequisites

- Node.js >= 18
- One of:
  - `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com) (free tier available)
  - `OPENAI_API_KEY` from [OpenAI Platform](https://platform.openai.com)
  - [Ollama](https://ollama.ai) running locally (`ollama serve && ollama pull llama3`)

---

## Setup

```bash
# 1. Clone this repo
git clone https://github.com/tusiim3/specsync.git && cd specsync

# 2. Install dependencies
npm install

# 3. Clone a target repository to analyze (example uses Express.js)
git clone --depth 1 https://github.com/expressjs/express demo/target-repo

# 4. Configure your LLM provider
cp .env.example .env
# Edit .env and set GEMINI_API_KEY, OPENAI_API_KEY, or configure Ollama

# 5. Build
npm run build
```

---

## Usage

```bash
# Run drift analysis on the included demo spec vs Express source
npm start -- run --spec demo/spec.md --repo demo/target-repo/lib

# Use your own spec and codebase
npm start -- run --spec /path/to/your/spec.md --repo /path/to/your/src

# Control output paths
npm start -- run \
  --spec demo/spec.md \
  --repo demo/target-repo/lib \
  --out my-drift-report.md \
  --store my-drift-map.json
```

### Expected output

```
  Using LLM provider: Gemini (gemini-3.5-flash-lite)

[1/5] Ingesting spec document...
      Found 8 requirement sections.

[2/5] Embedding spec requirements...
      Embedded 8 requirements.

[3/5] Chunking and embedding codebase...
      Found 67 code chunks.
      Embedded 67 code chunks.

[4/5] Running parallel coverage agents...

  Spawning 8 coverage agents (max 8 parallel)...

  [agent-01] checking: "Basic Request Routing"
  [agent-02] checking: "Middleware Pipeline"
  ...all 8 agents fire simultaneously...
  [agent-04] done:    covered (0.95) - Response Methods
  [agent-07] done:    gap     (0.95) - Request Body Size Limit Enforcement

[5/5] Generating drift report...

+----------------------------------------------------------+
|  SPECSYNC DRIFT REPORT                                   |
+----------------------------------------------------------+
|  DRIFT SCORE: 38/100                                     |
|  3/8 requirements covered  *  5 gaps  *  20 surplus      |
+----------------------------------------------------------+
```

---

## Demo Spec

`demo/spec.md` is an 8-section specification for the Express.js framework.
Two sections are intentionally left without implementations to demonstrate gap detection:

| Section | Result | Notes |
|---|---|---|
| Basic Request Routing | covered (0.85) | `lib/application.js` routing methods |
| Middleware Pipeline | gap (0.40) | partial match only |
| Request Body Parsing | gap (0.95) | handled by `body-parser`, not Express core |
| Response Methods | covered (0.95) | `lib/response.js` full API |
| Trust Proxy Configuration | covered (0.85) | `app.set('trust proxy')` in `lib/application.js` |
| Strict Mode Routing | gap (0.20) | setting exists but not confirmed by candidates |
| **Request Body Size Limit** | **gap (0.95)** | seeded gap: requires `body-parser` |
| **Rate Limiting Middleware** | **gap (1.00)** | seeded gap: requires `express-rate-limit` |

---

## Project Structure

```
specsync/
├── src/
│   ├── ingest/           # normalizeToMarkdown, splitSections, chunkCodebase
│   ├── embed/            # @huggingface/transformers local embedder
│   ├── search/           # cosine similarity top-K retrieval
│   ├── agents/           # coverage-agent (LLM), orchestrator (Promise.all)
│   ├── llm/              # GeminiProvider, OpenAIProvider, OllamaProvider, resolver
│   ├── report/           # generator, cli-printer, md-writer
│   ├── store/            # flat JSON run history
│   ├── pipeline.ts       # end-to-end pipeline
│   └── cli.ts            # commander CLI entry point
├── demo/
│   ├── spec.md           # sample spec with seeded drift
│   └── target-repo/      # cloned target codebase (not committed)
├── PLANNING.md           # architecture decisions
├── DECISIONS.md          # implementation decision log
└── README.md
```

---

## Future Work

- **PR comment bot** - GitHub Actions workflow that runs SpecSync on every PR and comments on the diff when a change breaks a spec mapping
- **Web dashboard** - visualize drift score trends across multiple runs
- **SQLite store** - replace flat JSON with SQLite for multi-project tracking and historical trend queries
- **Docling integration** - higher-fidelity PDF/DOCX ingestion for complex documents
- **Multi-language chunker** - AST-based chunking for Python, Java, Go

---

## License

CC BY-NC 4.0 - see [LICENSE](LICENSE) for details.
