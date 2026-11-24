import { posix } from 'path';
import type { DriftReport, Evidence, Requirement, RequirementResult } from '../types.js';
import type { ReportDiff } from './diff.js';
import { signed } from './text.js';

export const COMMENT_MARKER = '<!-- specsync-report -->';

export interface MarkdownOptions {
  /** e.g. "https://github.com/o/r/blob/<sha>/" to link evidence and spec lines. */
  linkBase?: string;
  /** Compact layout for PR comments: collapses implemented requirements. */
  compact?: boolean;
  title?: string;
}

const ICON: Record<RequirementResult['verdict'], string> = {
  implemented: '✅',
  partial: '🟡',
  missing: '❌',
  'not-verifiable': '⚪',
  error: '⚠️',
};

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function link(base: string | undefined, path: string, start: number, end?: number): string {
  const label = `${path}:${start}${end && end !== start ? `-${end}` : ''}`;
  if (!base) return `\`${label}\``;
  const anchor = end && end !== start ? `#L${start}-L${end}` : `#L${start}`;
  return `[\`${label}\`](${base.replace(/\/?$/, '/')}${path.split('/').map(encodeURIComponent).join('/')}${anchor})`;
}

function evidenceLink(report: DriftReport, e: Evidence, base?: string): string {
  // Evidence paths are relative to the analyzed repo dir; links need repo-root paths.
  const path = posix.join(report.repoDir === '.' ? '' : report.repoDir, e.filePath);
  return `${link(base, path, e.startLine, e.endLine)}${e.symbol ? ` \`${e.symbol}\`` : ''}`;
}

function specLink(req: Requirement, base?: string): string {
  return req.source.file ? link(base, req.source.file, req.source.line) : '';
}

function scoreLine(report: DriftReport): string {
  const s = report.score === null ? '--' : `${report.score}`;
  return `**Spec coverage: ${s}/100**`;
}

/** Full Markdown report, also used (compact) as the PR comment body. */
export function renderMarkdown(report: DriftReport, diff?: ReportDiff, opts: MarkdownOptions = {}): string {
  const reqs = new Map(report.requirements.map((r) => [r.id, r]));
  const { counts } = report;
  const out: string[] = [];

  if (opts.compact) out.push(COMMENT_MARKER);
  out.push(`## ${opts.title ?? 'SpecSync drift report'}`);
  out.push('');

  let headline = scoreLine(report);
  if (diff && diff.scoreBefore !== null && diff.scoreAfter !== null && diff.scoreBefore !== diff.scoreAfter) {
    headline += ` (${signed(diff.scoreAfter - diff.scoreBefore)} vs base)`;
  }
  out.push(headline);
  out.push('');
  out.push(
    `${counts.implemented} implemented · ${counts.partial} partial · ${counts.missing} missing` +
      (counts.notVerifiable ? ` · ${counts.notVerifiable} not verifiable` : '') +
      (counts.error ? ` · ${counts.error} errors` : '') +
      ` · ${report.requirements.length} requirements`,
  );
  if (!report.complete) {
    out.push('');
    out.push('> [!WARNING]');
    out.push('> Some requirements could not be checked (provider errors), so this score is partial.');
  }

  if (diff && (diff.regressions.length || diff.improvements.length || diff.added.length || diff.removed.length)) {
    out.push('');
    out.push('### Changes in this run');
    out.push('');
    for (const c of diff.regressions) out.push(`- 🔻 **${esc(c.requirement.heading)}**: ${c.from} → ${c.to}`);
    for (const c of diff.improvements) out.push(`- 🔺 **${esc(c.requirement.heading)}**: ${c.from} → ${c.to}`);
    for (const r of diff.added) out.push(`- ➕ New requirement: **${esc(r.heading)}**`);
    for (const r of diff.removed) out.push(`- ➖ Removed requirement: **${esc(r.heading)}**`);
  }

  const attention = report.results.filter((r) => r.verdict === 'missing' || r.verdict === 'partial' || r.verdict === 'error');
  if (attention.length) {
    out.push('');
    out.push('### Needs attention');
    out.push('');
    for (const r of attention) {
      const req = reqs.get(r.requirementId);
      out.push(`#### ${ICON[r.verdict]} ${esc(req?.heading ?? r.requirementId)}`);
      out.push('');
      const meta = [r.verdict, r.verdict === 'error' ? '' : `${Math.round(r.confidence * 100)}% confidence`, req ? specLink(req, opts.linkBase) : '']
        .filter(Boolean)
        .join(' · ');
      out.push(meta);
      out.push('');
      const note = r.verdict === 'error' ? r.error : r.notes;
      if (note) {
        out.push(note);
        out.push('');
      }
      for (const e of r.evidence) out.push(`- ${evidenceLink(report, e, opts.linkBase)}: ${esc(e.reason)}`);
      if (r.evidence.length) out.push('');
    }
  }

  const table = (rows: RequirementResult[]) => {
    out.push('| | Requirement | Verdict | Evidence |');
    out.push('|---|---|---|---|');
    for (const r of rows) {
      const req = reqs.get(r.requirementId);
      const ev = r.evidence.slice(0, 2).map((e) => evidenceLink(report, e, opts.linkBase)).join('<br>');
      out.push(`| ${ICON[r.verdict]} | ${esc(req?.heading ?? r.requirementId)} | ${r.verdict} | ${ev || '—'} |`);
    }
  };

  out.push('');
  if (opts.compact) {
    out.push(`<details><summary>All ${report.results.length} requirements</summary>`);
    out.push('');
    table(report.results);
    out.push('');
    out.push('</details>');
  } else {
    out.push('### All requirements');
    out.push('');
    table(report.results);
  }

  if (report.surplus.length) {
    out.push('');
    const title = `Unmapped public code (${report.surplus.length} of ${report.publicSymbols} public symbols)`;
    if (opts.compact) out.push(`<details><summary>${title}</summary>`, '');
    else out.push(`### ${title}`, '');
    out.push('Public functions and classes that no requirement points to. Either the spec is behind the code, or this is unplanned behaviour.');
    out.push('');
    for (const s of report.surplus) {
      const path = posix.join(report.repoDir === '.' ? '' : report.repoDir, s.filePath);
      out.push(`- ${link(opts.linkBase, path, s.startLine, s.endLine)}${s.symbol ? ` \`${s.symbol}\`` : ''}`);
    }
    if (opts.compact) out.push('', '</details>');
  }

  out.push('');
  out.push(
    `<sub>SpecSync · ${report.provider} ${report.model} · ${report.stats.llmCalls} LLM calls, ${report.stats.cacheHits} cached · coverage = (implemented + ½·partial) / checked requirements</sub>`,
  );
  out.push('');
  return out.join('\n');
}
