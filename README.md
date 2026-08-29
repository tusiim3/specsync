# SpecSync

> Spec-to-code drift detection using parallel LLM subagents
> IBM TechXchange 2026 Hackathon, Dev Day, Aug 28-30 2026

---

## The Problem

Teams write a spec or PRD once. Code then drifts from it silently — nobody notices
until a bug surfaces or an audit forces a reconciliation. There is no automated bridge
between the spec document and the codebase.

## The Solution

SpecSync ingests a spec document (Markdown, PDF, or DOCX) and a codebase, uses
**parallel LLM subagents** to map spec requirements to the code that implements them,
and produces a **drift report**:

- **Drift score** — a single 0-100 number: % of spec requirements that are covered
- **Gap list** — spec requirements with no implementing code found
- **Surplus list** — code behavior with no matching requirement

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
- **Hybrid mapping**: embeddings shortlist candidates, LLM confirms coverage, bounded
  to N_requirements x 1 LLM calls, not N x M
- **Model-agnostic**: auto-selects Gemini -> OpenAI -> Ollama based on env vars
- **Parallel subagents**: Promise.all fan-out, visibly logged per-agent

---

## Prerequisites

- Node.js >= 18
- One of:
  - `GEMINI_API_KEY` — [Google AI Studio](https://aistudio.google.com) (free tier)
  - `OPENAI_API_KEY` — [OpenAI Platform](https://platform.openai.com)
  - [Ollama](https://ollama.ai) running locally (`ollama serve && ollama pull llama3`)

---

## Setup

```bash
# 1. Clone this repo
git clone <this-repo> specsync && cd specsync

# 2. Install dependencies
npm install

# 3. Clone the demo target repository (Express.js)
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
# Run drift analysis on the demo spec vs Express source
npm start -- run --spec demo/spec.md --repo demo/target-repo/lib

# Use a custom spec and codebase
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
  Using LLM provider: Gemini (gemini-1.5-flash)

[1/5] Ingesting spec document...
      Found 8 requirement sections.

[2/5] Embedding spec requirements...
      Embedded 8 requirements.

[3/5] Chunking and embedding codebase...
      Found 18 code chunks.
      Embedded 18 code chunks.

[4/5] Running parallel coverage agents...

  Spawning 8 coverage agents (max 8 parallel)...

  [agent-01] checking: "Basic Request Routing"
  [agent-02] checking: "Middleware Pipeline"
  ...all 8 agents fire simultaneously...
  [agent-04] done:    covered (0.91) - Response Methods
  [agent-07] done:    gap     (0.12) - Request Body Size Limit Enforcement

[5/5] Generating drift report...

+----------------------------------------------------------+
|  SPECSYNC DRIFT REPORT                                   |
+----------------------------------------------------------+
|  DRIFT SCORE: 37/100                                     |
|  3/8 requirements covered  *  5 gaps  *  6 surplus chunks|
+----------------------------------------------------------+
```

---

## Demo Spec

`demo/spec.md` is an 8-section specification for the Express.js framework with
**intentional drift seeded in**:

| Section | Status | Why |
|---|---|---|
| Basic Request Routing | covered | `lib/application.js` implements routing |
| Middleware Pipeline | covered | `lib/application.js` `.use()` pipeline |
| Request Body Parsing | covered | `lib/request.js` body handling |
| Response Methods | covered | `lib/response.js` full API |
| Trust Proxy Configuration | covered | `lib/application.js` trust proxy setting |
| Strict Mode Routing | covered | `lib/application.js` strict routing |
| **Request Body Size Limit** | **gap** | Requires `body-parser`, not in Express core |
| **Rate Limiting Middleware** | **gap** | Requires `express-rate-limit`, not in Express core |

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
│   ├── spec.md           # hand-written Express spec with seeded drift
│   └── target-repo/      # git clone --depth 1 expressjs/express (not committed)
├── bob_sessions/         # IBM Bob task session screenshots
├── PLANNING.md           # architecture decisions (all 7 ASK ME items)
├── DECISIONS.md          # YOUR CALL implementation log
└── README.md
```

---

## Future Work

- **PR comment bot** — GitHub Actions workflow that runs SpecSync on every PR and
  comments on the diff when a change breaks a spec mapping
- **Web dashboard** — visualize drift score trends across multiple runs
- **SQLite store** — replace flat JSON with SQLite for multi-project tracking
  and historical trend queries
- **Docling integration** — higher-fidelity PDF/DOCX ingestion for complex documents
- **Multi-language code chunker** — AST-based chunking for Python, Java, Go

---

## Built With IBM Bob

This project was built entirely using IBM Bob IDE during the TechXchange 2026
Pre-conference Dev Day Hackathon. See `bob_sessions/` for session screenshots.
