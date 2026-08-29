import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { DriftReport } from '../types.js';

export async function writeMarkdownReport(
  report: DriftReport,
  outPath: string,
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });

  const {
    score,
    totalRequirements,
    coveredCount,
    gapList,
    surplusList,
    details,
    runId,
    timestamp,
    specFile,
    repoDir,
  } = report;

  const lines: string[] = [];

  lines.push('# SpecSync Drift Report');
  lines.push('');
  lines.push(`> Generated: ${timestamp}  `);
  lines.push(`> Run ID: \`${runId}\`  `);
  lines.push(`> Spec: \`${specFile}\`  `);
  lines.push(`> Repo: \`${repoDir}\``);
  lines.push('');

  lines.push('## Drift Score');
  lines.push('');
  lines.push(`**${score}/100** — ${coveredCount} of ${totalRequirements} requirements covered`);
  lines.push('');

  const scoreBar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5));
  lines.push(`\`[${scoreBar}]\``);
  lines.push('');

  // Gaps
  lines.push('## Gaps — Requirements with No Implementing Code');
  lines.push('');
  if (gapList.length === 0) {
    lines.push('_No gaps found — all requirements are covered._');
  } else {
    for (const req of gapList) {
      const detail = details.find((d) => d.requirementId === req.id);
      lines.push(`### ✗ ${req.heading}`);
      lines.push('');
      lines.push(`**Spec text:** ${req.body.slice(0, 300)}${req.body.length > 300 ? '...' : ''}`);
      lines.push('');
      if (detail?.notes) {
        lines.push(`**Analysis:** ${detail.notes}`);
        lines.push('');
      }
    }
  }

  // Surplus
  lines.push('## Surplus — Code with No Matching Requirement');
  lines.push('');
  if (surplusList.length === 0) {
    lines.push('_No surplus code found._');
  } else {
    for (const chunk of surplusList) {
      lines.push(`- \`${chunk.filePath}:${chunk.startLine}\` — ${chunk.preview}`);
    }
  }
  lines.push('');

  // Detail table
  lines.push('## Coverage Detail');
  lines.push('');
  lines.push('| Requirement | Covered | Confidence | Notes |');
  lines.push('|---|---|---|---|');
  for (const result of details) {
    const heading =
      gapList.find((r) => r.id === result.requirementId)?.heading ??
      result.requirementId;
    const icon = result.covered ? '✓' : '✗';
    lines.push(
      `| ${heading} | ${icon} | ${result.confidence.toFixed(2)} | ${result.notes.slice(0, 80)} |`,
    );
  }
  lines.push('');

  await writeFile(outPath, lines.join('\n'), 'utf-8');
}
