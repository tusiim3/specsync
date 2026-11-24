import type { DriftReport, Requirement, RequirementResult } from '../types.js';
import type { ReportDiff } from './diff.js';

export interface TextOptions {
  color?: boolean;
  /** Width of the score bar. */
  barWidth?: number;
}

function palette(color: boolean) {
  const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: c('1'),
    dim: c('2'),
    red: c('31'),
    green: c('32'),
    yellow: c('33'),
    blue: c('34'),
    magenta: c('35'),
    cyan: c('36'),
    gray: c('90'),
  };
}

export function scoreBar(score: number | null, width = 24): string {
  const filled = score === null ? 0 : Math.round((score / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function location(r: Requirement): string {
  return r.source.file ? `${r.source.file}:${r.source.line}` : '';
}

/** Human-readable terminal report. */
export function renderText(report: DriftReport, diff?: ReportDiff, opts: TextOptions = {}): string {
  const p = palette(opts.color ?? false);
  const out: string[] = [];
  const { counts } = report;
  const reqs = new Map(report.requirements.map((r) => [r.id, r]));

  const scoreColor = report.score === null ? p.gray : report.score >= 80 ? p.green : report.score >= 50 ? p.yellow : p.red;
  const scoreText = report.score === null ? '--' : String(report.score);

  out.push('');
  out.push(
    `  ${p.bold('SpecSync')}  ${p.dim('spec coverage')} ${scoreColor(p.bold(`${scoreText}/100`))}  ${scoreColor(scoreBar(report.score, opts.barWidth))}`,
  );
  const parts = [
    `${report.requirements.length} requirements`,
    p.green(`${counts.implemented} implemented`),
    p.yellow(`${counts.partial} partial`),
    p.red(`${counts.missing} missing`),
  ];
  if (counts.notVerifiable) parts.push(p.gray(`${counts.notVerifiable} not verifiable`));
  if (counts.error) parts.push(p.magenta(`${counts.error} errors`));
  out.push(`  ${parts.join(p.dim(' · '))}`);
  if (!report.complete) {
    out.push(`  ${p.magenta('Incomplete run: some requirements could not be checked, so the score is partial.')}`);
  }

  if (diff) {
    const delta =
      diff.scoreBefore === null || diff.scoreAfter === null ? '' : ` (${signed(diff.scoreAfter - diff.scoreBefore)})`;
    out.push(`  ${p.dim(`vs previous: ${diff.scoreBefore ?? '--'} → ${diff.scoreAfter ?? '--'}${delta}`)}`);
    for (const c of diff.regressions) out.push(`  ${p.red('▼')} ${c.requirement.heading} ${p.dim(`${c.from} → ${c.to}`)}`);
    for (const c of diff.improvements) out.push(`  ${p.green('▲')} ${c.requirement.heading} ${p.dim(`${c.from} → ${c.to}`)}`);
  }

  const section = (title: string, verdict: RequirementResult['verdict'], icon: string, color: (s: string) => string) => {
    const rows = report.results.filter((r) => r.verdict === verdict);
    if (!rows.length) return;
    out.push('');
    out.push(`  ${p.bold(color(title))}`);
    for (const r of rows) {
      const req = reqs.get(r.requirementId);
      const heading = req?.heading ?? r.requirementId;
      const conf = r.verdict === 'error' ? '' : p.dim(` ${Math.round(r.confidence * 100)}%`);
      out.push(`  ${color(icon)} ${heading}${conf}  ${p.gray(req ? location(req) : '')}`);
      const note = r.verdict === 'error' ? r.error ?? '' : r.notes;
      if (note) out.push(`      ${p.dim(note)}`);
      for (const e of r.evidence.slice(0, 3)) {
        out.push(`      ${p.cyan(`${e.filePath}:${e.startLine}-${e.endLine}`)}${e.symbol ? p.dim(` ${e.symbol}`) : ''}`);
      }
      if (r.evidence.length > 3) out.push(`      ${p.dim(`+${r.evidence.length - 3} more`)}`);
    }
  };

  section('MISSING', 'missing', '✗', p.red);
  section('PARTIAL', 'partial', '◐', p.yellow);
  section('IMPLEMENTED', 'implemented', '✓', p.green);
  section('NOT VERIFIABLE FROM CODE', 'not-verifiable', '–', p.gray);
  section('ERRORS', 'error', '!', p.magenta);

  if (report.surplus.length) {
    out.push('');
    out.push(
      `  ${p.bold(p.blue('UNMAPPED PUBLIC CODE'))} ${p.dim(`(${report.surplus.length} shown, ${report.publicSymbols} public symbols total)`)}`,
    );
    for (const s of report.surplus) {
      out.push(`  ${p.blue('△')} ${p.cyan(`${s.filePath}:${s.startLine}`)} ${s.symbol ?? ''}`);
    }
  }

  const st = report.stats;
  out.push('');
  out.push(
    p.dim(
      `  ${report.provider} ${report.model} · ${st.files} files · ${st.chunks} chunks · ${st.llmCalls} LLM calls · ${st.cacheHits} cached · ${(st.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  out.push('');
  return out.join('\n');
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
