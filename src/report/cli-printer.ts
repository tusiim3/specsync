import type { DriftReport } from '../types.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function scoreColor(score: number): string {
  if (score >= 80) return GREEN;
  if (score >= 50) return YELLOW;
  return RED;
}

export function printReport(report: DriftReport): void {
  const { score, totalRequirements, coveredCount, gapList, surplusList, details } =
    report;

  const bar = scoreColor(score);

  console.log('');
  console.log(
    `${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`,
  );
  console.log(
    `${BOLD}║  SPECSYNC DRIFT REPORT                                   ║${RESET}`,
  );
  console.log(
    `${BOLD}╠══════════════════════════════════════════════════════════╣${RESET}`,
  );
  console.log(
    `${BOLD}║  DRIFT SCORE: ${bar}${String(score).padEnd(3)}${RESET}${BOLD}/100${RESET}${BOLD}                                       ║${RESET}`,
  );
  console.log(
    `${BOLD}║  ${coveredCount}/${totalRequirements} requirements covered  •  ${gapList.length} gaps  •  ${surplusList.length} surplus chunks${' '.repeat(Math.max(0, 10 - String(surplusList.length).length))}║${RESET}`,
  );
  console.log(
    `${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`,
  );
  console.log('');

  // ── Gap List ────────────────────────────────────────────────────────────────
  if (gapList.length === 0) {
    console.log(`${GREEN}${BOLD}✓ No gaps — all spec requirements are covered.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}GAPS — Spec requirements with no implementing code:${RESET}`);
    console.log('');
    for (const req of gapList) {
      const detail = details.find((d) => d.requirementId === req.id);
      console.log(`  ${RED}✗${RESET} ${BOLD}${req.heading}${RESET}`);
      if (detail?.notes) {
        console.log(`    ${DIM}${detail.notes}${RESET}`);
      }
      console.log('');
    }
  }

  // ── Surplus List ───────────────────────────────────────────────────────────
  if (surplusList.length > 0) {
    console.log(
      `${YELLOW}${BOLD}SURPLUS — Code with no matching spec requirement (top ${surplusList.length}):${RESET}`,
    );
    console.log('');
    for (const chunk of surplusList) {
      console.log(`  ${YELLOW}△${RESET} ${CYAN}${chunk.filePath}:${chunk.startLine}${RESET}`);
      console.log(`    ${DIM}${chunk.preview}${RESET}`);
      console.log('');
    }
  }

  // ── Coverage Detail Table ──────────────────────────────────────────────────
  console.log(`${BOLD}COVERAGE DETAIL:${RESET}`);
  console.log('');
  for (const result of details) {
    const icon = result.covered ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const conf = `${DIM}(${result.confidence.toFixed(2)})${RESET}`;
    const heading =
      report.gapList.find((r) => r.id === result.requirementId)?.heading ??
      result.requirementId;
    console.log(`  ${icon} ${heading} ${conf}`);
    if (result.evidence.length > 0) {
      console.log(`    ${DIM}evidence: ${result.evidence.slice(0, 3).join(', ')}${RESET}`);
    }
  }

  console.log('');
  console.log(`${DIM}Run ID: ${report.runId}${RESET}`);
  console.log(`${DIM}Spec:   ${report.specFile}${RESET}`);
  console.log(`${DIM}Repo:   ${report.repoDir}${RESET}`);
  console.log(`${DIM}Time:   ${report.timestamp}${RESET}`);
  console.log('');
}
