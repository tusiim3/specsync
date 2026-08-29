import { randomUUID } from 'crypto';
import type {
  Requirement,
  CoverageResult,
  SurplusChunk,
  DriftReport,
} from '../types.js';

const CONFIDENCE_THRESHOLD = 0.7;

interface GenerateReportInput {
  specFile: string;
  repoDir: string;
  requirements: Requirement[];
  coverageResults: CoverageResult[];
  surplusChunks: SurplusChunk[];
}

export function generateReport(input: GenerateReportInput): DriftReport {
  const {
    specFile,
    repoDir,
    requirements,
    coverageResults,
    surplusChunks,
  } = input;

  const covered = coverageResults.filter(
    (r) => r.covered && r.confidence >= CONFIDENCE_THRESHOLD,
  );

  const coveredIds = new Set(covered.map((r) => r.requirementId));

  const gapList = requirements.filter((r) => !coveredIds.has(r.id));

  const score = requirements.length === 0
    ? 0
    : Math.round((covered.length / requirements.length) * 100);

  return {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    specFile,
    repoDir,
    score,
    totalRequirements: requirements.length,
    coveredCount: covered.length,
    gapList,
    surplusList: surplusChunks,
    details: coverageResults,
  };
}
