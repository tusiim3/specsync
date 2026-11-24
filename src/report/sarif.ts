import type { DriftReport } from '../types.js';

import { VERSION } from '../version.js';

/**
 * SARIF 2.1.0 output so gaps show up in GitHub code scanning.
 * Missing/partial requirements are reported at their line in the spec file.
 */
export function renderSarif(report: DriftReport): string {
  const reqs = new Map(report.requirements.map((r) => [r.id, r]));
  const results = report.results
    .filter((r) => r.verdict === 'missing' || r.verdict === 'partial')
    .map((r) => {
      const req = reqs.get(r.requirementId);
      return {
        ruleId: r.verdict === 'missing' ? 'specsync/missing' : 'specsync/partial',
        level: r.verdict === 'missing' ? 'error' : 'warning',
        message: {
          text: `${r.verdict === 'missing' ? 'Not implemented' : 'Partially implemented'}: ${req?.heading ?? r.requirementId}. ${r.notes}`.trim(),
        },
        partialFingerprints: { requirementId: r.requirementId },
        locations: req?.source.file
          ? [
              {
                physicalLocation: {
                  artifactLocation: { uri: req.source.file },
                  region: { startLine: Math.max(1, req.source.line) },
                },
              },
            ]
          : [],
        relatedLocations: r.evidence.map((e, i) => ({
          id: i + 1,
          message: { text: e.reason || e.symbol || e.chunkId },
          physicalLocation: {
            artifactLocation: { uri: report.repoDir === '.' ? e.filePath : `${report.repoDir}/${e.filePath}` },
            region: { startLine: e.startLine, endLine: e.endLine },
          },
        })),
      };
    });

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SpecSync',
            version: VERSION,
            informationUri: 'https://github.com/tusiim3/specsync',
            rules: [
              {
                id: 'specsync/missing',
                name: 'RequirementMissing',
                shortDescription: { text: 'Spec requirement with no implementing code' },
                defaultConfiguration: { level: 'error' },
              },
              {
                id: 'specsync/partial',
                name: 'RequirementPartial',
                shortDescription: { text: 'Spec requirement only partly implemented' },
                defaultConfiguration: { level: 'warning' },
              },
            ],
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
