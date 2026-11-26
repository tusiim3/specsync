/**
 * Create or update SpecSync's single PR comment (found by a hidden marker).
 * Used by the GitHub Action: node dist/action/comment.js <markdown-file>
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { COMMENT_MARKER } from '../report/markdown.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpsertOptions {
  token: string;
  repository: string;
  issueNumber: number;
  body: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

export type UpsertResult = { action: 'created' | 'updated'; id: number; url: string };

/** GitHub limits comment bodies to 65536 characters. */
const MAX_BODY = 65_000;

export async function upsertComment(opts: UpsertOptions): Promise<UpsertResult> {
  const f = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'specsync-action',
  };
  let body = opts.body.includes(COMMENT_MARKER) ? opts.body : `${COMMENT_MARKER}\n${opts.body}`;
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n\n_Report truncated to fit GitHub's comment limit. See the job summary for the full report._`;
  }

  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
    return res;
  };

  let existing: { id: number } | undefined;
  for (let page = 1; page <= 20 && !existing; page++) {
    const res = await check(
      await f(`${api}/repos/${opts.repository}/issues/${opts.issueNumber}/comments?per_page=100&page=${page}`, { headers }),
      'listing comments',
    );
    const comments = (await res.json()) as Array<{ id: number; body?: string }>;
    existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (comments.length < 100) break;
  }

  if (existing) {
    const res = await check(
      await f(`${api}/repos/${opts.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) }),
      'updating comment',
    );
    const c = (await res.json()) as { id: number; html_url: string };
    return { action: 'updated', id: c.id, url: c.html_url };
  }
  const res = await check(
    await f(`${api}/repos/${opts.repository}/issues/${opts.issueNumber}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) }),
    'creating comment',
  );
  const c = (await res.json()) as { id: number; html_url: string };
  return { action: 'created', id: c.id, url: c.html_url };
}

/** PR number from the event payload of pull_request / pull_request_target / issue_comment events. */
export function issueNumberFrom(event: unknown): number | undefined {
  const e = event as { pull_request?: { number?: number }; issue?: { number?: number; pull_request?: unknown }; number?: number };
  return e.pull_request?.number ?? (e.issue?.pull_request ? e.issue.number : undefined) ?? e.number;
}

async function main() {
  const file = process.argv[2];
  const token = process.env['GITHUB_TOKEN'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (!file || !existsSync(file) || !token || !repository || !eventPath) {
    console.log('::warning::SpecSync comment skipped: missing report file, token, repository or event.');
    return;
  }
  const issueNumber = issueNumberFrom(JSON.parse(await readFile(eventPath, 'utf-8')));
  if (!issueNumber) {
    console.log('SpecSync comment skipped: not a pull request event.');
    return;
  }
  try {
    const r = await upsertComment({
      token,
      repository,
      issueNumber,
      body: await readFile(file, 'utf-8'),
      apiUrl: process.env['GITHUB_API_URL'],
    });
    console.log(`SpecSync comment ${r.action}: ${r.url}`);
  } catch (err) {
    // Forks get a read-only token; the report is still in the job summary.
    console.log(`::warning::Could not post the SpecSync comment (${(err as Error).message}). The report is in the job summary.`);
  }
}

if (process.argv[1] && /comment\.[jt]s$/.test(process.argv[1])) void main();
