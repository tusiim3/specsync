#!/usr/bin/env node
import { program } from 'commander';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { config as loadDotenv } from 'process';

// Load .env if present (best-effort, no hard dep on dotenv)
try {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  // Try to load .env manually
  const { readFileSync } = await import('fs');
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch {
  // .env loading is best-effort
}

import { resolveProvider } from './llm/resolver.js';
import { runPipeline } from './pipeline.js';
import { printReport } from './report/cli-printer.js';
import { writeMarkdownReport } from './report/md-writer.js';
import { appendRun } from './store/json-store.js';

program
  .name('specsync')
  .description('Spec-to-code drift detection using parallel LLM subagents')
  .version('0.1.0');

program
  .command('run')
  .description('Analyze a spec document against a codebase and produce a drift report')
  .requiredOption('--spec <path>', 'Path to the spec document (.md, .pdf, or .docx)')
  .requiredOption('--repo <path>', 'Path to the codebase directory to analyze')
  .option('--out <path>', 'Output path for the Markdown report', 'drift-report.md')
  .option('--store <path>', 'Path to the drift history JSON store', 'drift-map.json')
  .action(
    async (opts: {
      spec: string;
      repo: string;
      out: string;
      store: string;
    }) => {
      const specFile = resolve(opts.spec);
      const repoDir = resolve(opts.repo);

      if (!existsSync(specFile)) {
        console.error(`Error: spec file not found: ${specFile}`);
        process.exit(1);
      }

      if (!existsSync(repoDir)) {
        console.error(`Error: repo directory not found: ${repoDir}`);
        console.error(
          `Hint: run  git clone --depth 1 https://github.com/expressjs/express demo/target-repo`,
        );
        process.exit(1);
      }

      let provider;
      try {
        provider = await resolveProvider();
        console.error(`  Using LLM provider: ${provider.name}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      try {
        const report = await runPipeline({ specFile, repoDir, provider });

        // Print to terminal
        printReport(report);

        // Write Markdown artifact
        await writeMarkdownReport(report, resolve(opts.out));
        console.error(`  Markdown report written to: ${opts.out}`);

        // Append to history store
        await appendRun(report, resolve(opts.store));
        console.error(`  Run appended to store:      ${opts.store}`);
      } catch (err) {
        console.error(`\nError during analysis: ${(err as Error).message}`);
        if (process.env['DEBUG']) {
          console.error((err as Error).stack);
        }
        process.exit(1);
      }
    },
  );

program.parse();
