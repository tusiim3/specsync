import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { splitSections, subQueries, requirementText, slugify } from '../src/ingest/section-split.js';
import { normalizeToMarkdown } from '../src/ingest/normalize.js';
import { listSourceFiles } from '../src/ingest/files.js';
import { FIXTURES, TODO_API, withTempDir } from './helpers.js';

describe('splitSections', () => {
  it('treats a single leading H1 as the title and splits ## sections', () => {
    const md = '# My Spec\n\nIntro.\n\n## Login\n\nUsers log in.\n\n## Logout\n\nUsers log out.\n';
    const reqs = splitSections(md, { file: 'spec.md' });
    expect(reqs.map((r) => r.id)).toEqual(['login', 'logout']);
    expect(reqs[0]).toMatchObject({ heading: 'Login', body: 'Users log in.', path: [], source: { file: 'spec.md', line: 5 } });
    expect(reqs[1]!.source.line).toBe(9);
  });

  it('uses H1 sections as requirements when there are several H1s (e.g. converted Word docs)', () => {
    const md = '# Auth\n\nSign in.\n\n# Export\n\nDownload data.\n';
    expect(splitSections(md).map((r) => r.id)).toEqual(['auth', 'export']);
  });

  it('keeps parent headings as path and skips heading-only sections', () => {
    const md = '# T\n\n## Accounts\n\n### Sign up\n\nEmail and password.\n\n### Delete\n\nUsers can delete.\n';
    const reqs = splitSections(md);
    expect(reqs.map((r) => r.id)).toEqual(['sign-up', 'delete']);
    expect(reqs[0]!.path).toEqual(['Accounts']);
    expect(requirementText(reqs[0]!)).toContain('Accounts › Sign up');
  });

  it('honours explicit ids in headings', () => {
    const md = '## REQ-12: Login\n\nx\n\n## [AUTH-3] Logout\n\ny\n\n## FR-1.2 - Export\n\nz\n';
    const reqs = splitSections(md);
    expect(reqs.map((r) => r.id)).toEqual(['REQ-12', 'AUTH-3', 'FR-1.2']);
    expect(reqs[0]!.heading).toBe('Login');
  });

  it('de-duplicates ids using the parent heading', () => {
    const md = '## Users\n\n### Limits\n\na\n\n## Files\n\n### Limits\n\nb\n\n### Limits\n\nc\n';
    expect(splitSections(md).map((r) => r.id)).toEqual(['limits', 'files-limits', 'limits-3']);
  });

  it('skips ignored sections and their subsections', () => {
    const md = '## Login\n\na\n\n## Out of scope\n\n- mobile\n\n### Details\n\nb\n\n## Glossary\n\nc\n\n## Export\n\nd\n';
    expect(splitSections(md).map((r) => r.id)).toEqual(['login', 'export']);
  });

  it('keeps lists and code in the body', () => {
    const md = '## Limits\n\nThe API must:\n\n- reject bodies over 1MB\n- return `413`\n\n```js\nlimit: "1mb"\n```\n';
    const body = splitSections(md)[0]!.body;
    expect(body).toContain('- reject bodies over 1MB');
    expect(body).toContain('limit: "1mb"');
  });

  it('leaves section numbers out of ids', () => {
    expect(splitSections('## 2.1 Session lifetime\n\nx\n')[0]!.id).toBe('session-lifetime');
  });

  it('builds one sub-query per list item', () => {
    const [req] = splitSections('## Response\n\n- `res.json(data)` sends JSON\n  with a content type\n- `res.send(body)` sends a body\n- x\n');
    expect(subQueries(req!)).toEqual([
      'Response: res.json(data) sends JSON with a content type',
      'Response: res.send(body) sends a body',
    ]);
  });

  it('slugifies accents and punctuation', () => {
    expect(slugify('Café — Login (v2)!')).toBe('cafe-login-v2');
  });
});

describe('normalizeToMarkdown', () => {
  it('keeps Word heading styles from .docx', async () => {
    const md = await normalizeToMarkdown(join(FIXTURES, 'specs/accounts.docx'));
    const reqs = splitSections(md);
    expect(reqs.map((r) => r.id)).toEqual(['authentication', 'password-reset', 'data-export']);
    expect(reqs[1]!.body).toContain('30 minutes');
  });

  it('infers headings from font size and numbering in .pdf', async () => {
    const md = await normalizeToMarkdown(join(FIXTURES, 'specs/accounts.pdf'));
    const reqs = splitSections(md);
    expect(reqs.map((r) => r.id)).toEqual(['authentication', 'password-reset', 'data-export', 'session-lifetime']);
    expect(reqs[0]!.body).toContain('at least 12 characters');
  });

  it('converts HTML and rejects unknown formats', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'spec.html'), '<h2>Login</h2><p>Users log in.</p>');
      expect(splitSections(await normalizeToMarkdown(join(dir, 'spec.html')))[0]!.id).toBe('login');
      await writeFile(join(dir, 'spec.xyz'), 'x');
      await expect(normalizeToMarkdown(join(dir, 'spec.xyz'))).rejects.toThrow(/Unsupported spec format/);
    });
  });
});

describe('listSourceFiles', () => {
  it('lists supported files in the fixture project', async () => {
    const files = await listSourceFiles(TODO_API);
    expect(files).toEqual([
      'export/exporter.go',
      'src/admin.ts',
      'src/auth.ts',
      'src/server.ts',
      'src/store.ts',
      'worker/reminders.py',
    ]);
  });

  it('matches exclusions relative to the repo, so a repo inside "build/" still works', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'build', 'project');
      await mkdir(join(repo, 'src'), { recursive: true });
      await mkdir(join(repo, 'dist'), { recursive: true });
      await mkdir(join(repo, 'node_modules', 'x'), { recursive: true });
      await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;');
      await writeFile(join(repo, 'src', 'a.test.ts'), 'test');
      await writeFile(join(repo, 'dist', 'a.js'), 'x');
      await writeFile(join(repo, 'node_modules', 'x', 'i.js'), 'x');
      await writeFile(join(repo, 'src', 'gen.ts'), 'x');
      await writeFile(join(repo, '.gitignore'), 'src/gen.ts\n');
      expect(await listSourceFiles(repo)).toEqual(['src/a.ts']);
      expect(await listSourceFiles(repo, { excludeTests: false })).toEqual(['src/a.test.ts', 'src/a.ts']);
      expect(await listSourceFiles(repo, { exclude: ['src/a.ts'] })).toEqual([]);
    });
  });
});
