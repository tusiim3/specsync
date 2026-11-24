import { describe, expect, it } from 'vitest';
import { upsertComment, issueNumberFrom } from '../src/action/comment.js';
import { COMMENT_MARKER } from '../src/report/markdown.js';

type Call = { url: string; method: string; body?: string; auth?: string };

function fakeGitHub(pages: Array<Array<{ id: number; body: string }>>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined, auth: (init?.headers as Record<string, string>)['authorization'] });
    if (method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 99, html_url: 'https://github.com/o/r/pull/1#c99' }), { status: method === 'POST' ? 201 : 200 });
  };
  return { calls, fetch: f };
}

describe('upsertComment', () => {
  it('creates a comment with the marker when none exists', async () => {
    const gh = fakeGitHub([[{ id: 1, body: 'unrelated' }]]);
    const r = await upsertComment({ token: 't', repository: 'o/r', issueNumber: 7, body: 'report', fetch: gh.fetch });
    expect(r).toEqual({ action: 'created', id: 99, url: 'https://github.com/o/r/pull/1#c99' });
    const post = gh.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.github.com/repos/o/r/issues/7/comments');
    expect(JSON.parse(post.body!).body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(post.auth).toBe('Bearer t');
  });

  it('updates the existing SpecSync comment, searching later pages', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' }));
    const gh = fakeGitHub([full, [{ id: 555, body: `${COMMENT_MARKER}\nold` }]]);
    const r = await upsertComment({ token: 't', repository: 'o/r', issueNumber: 7, body: `${COMMENT_MARKER}\nnew`, fetch: gh.fetch, apiUrl: 'https://ghe.example/api/v3/' });
    expect(r.action).toBe('updated');
    const patch = gh.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://ghe.example/api/v3/repos/o/r/issues/comments/555');
  });

  it('truncates bodies over the GitHub limit and surfaces API errors', async () => {
    const gh = fakeGitHub([[]]);
    await upsertComment({ token: 't', repository: 'o/r', issueNumber: 1, body: 'x'.repeat(70_000), fetch: gh.fetch });
    const sent = JSON.parse(gh.calls.find((c) => c.method === 'POST')!.body!).body as string;
    expect(sent.length).toBeLessThan(65_536);
    expect(sent).toContain('Report truncated');

    const failing = async () => new Response('forbidden', { status: 403 });
    await expect(upsertComment({ token: 't', repository: 'o/r', issueNumber: 1, body: 'b', fetch: failing })).rejects.toThrow(/403/);
  });
});

describe('issueNumberFrom', () => {
  it('reads PR numbers from pull_request and issue_comment events', () => {
    expect(issueNumberFrom({ pull_request: { number: 3 } })).toBe(3);
    expect(issueNumberFrom({ issue: { number: 4, pull_request: {} } })).toBe(4);
    expect(issueNumberFrom({ issue: { number: 5 } })).toBeUndefined();
    expect(issueNumberFrom({})).toBeUndefined();
  });
});
