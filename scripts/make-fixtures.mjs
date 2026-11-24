// Regenerates the binary spec fixtures used by the ingestion tests:
//   node scripts/make-fixtures.mjs
// Requires the docx dev dependency and Playwright with Chromium.
import { writeFile } from 'fs/promises';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';

const sections = [
  ['Authentication', 'Users sign in with an email address and a password of at least 12 characters.'],
  ['Password reset', 'A reset link is emailed and expires after 30 minutes.'],
  ['Data export', 'Users can download all of their data as a JSON file.'],
];

const doc = new Document({
  sections: [
    {
      children: [
        new Paragraph({ text: 'Accounts Service Specification', heading: HeadingLevel.TITLE }),
        new Paragraph({ text: 'This document describes the accounts service.' }),
        ...sections.flatMap(([h, body]) => [
          new Paragraph({ text: h, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: body }),
        ]),
      ],
    },
  ],
});
await writeFile('test/fixtures/specs/accounts.docx', await Packer.toBuffer(doc));

import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<html><body style="font-family: sans-serif; font-size: 11pt">
  <h1 style="font-size: 24pt">Accounts Service Specification</h1>
  <p>This document describes the accounts service.</p>
  ${sections.map(([h, b]) => `<h2 style="font-size: 16pt">${h}</h2><p>${b}</p>`).join('\n')}
  <p>2.1 Session lifetime</p>
  <p>Sessions expire after 7 days of inactivity.</p>
</body></html>`);
await page.pdf({ path: 'test/fixtures/specs/accounts.pdf', format: 'A4' });
await browser.close();
console.log('wrote test/fixtures/specs/accounts.{docx,pdf}');
