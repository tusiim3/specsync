import { lexer, type Token } from 'marked';
import { DEFAULT_IGNORE_SECTIONS } from '../config.js';
import type { Requirement } from '../types.js';

/** Explicit requirement ids in headings: "REQ-12: Login", "[AUTH-3] Logout", "FR-1.2 - Export". */
const EXPLICIT_ID = /^\[?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+(?:\.\d+)*)\]?\s*[:.\-–—)]?\s+(.+)$/;

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

export interface SplitOptions {
  /** File path recorded in requirement sources. */
  file?: string;
  /** Regex sources; matching sections (and their subsections) are skipped. */
  ignoreSections?: string[];
}

interface Section {
  depth: number;
  heading: string;
  explicitId?: string;
  path: string[];
  line: number;
  body: string[];
  ignored: boolean;
}

/**
 * Split Markdown into requirements: one per heading section that has body text.
 *
 * - A single leading H1 is treated as the document title, not a requirement.
 * - Parent headings are kept in `path` for context ("Auth › Login").
 * - Sections matching `ignoreSections` (e.g. "Out of scope", "Glossary") are
 *   skipped together with their subsections.
 * - Explicit ids in headings ("REQ-12: ...") are used as requirement ids;
 *   other ids are slugs, de-duplicated.
 */
export function splitSections(markdown: string, opts: SplitOptions = {}): Requirement[] {
  const ignore = (opts.ignoreSections ?? DEFAULT_IGNORE_SECTIONS).map((s) => new RegExp(s, 'i'));
  const tokens: Token[] = lexer(markdown);

  const h1Count = tokens.filter((t) => t.type === 'heading' && t.depth === 1).length;
  const firstHeading = tokens.find((t) => t.type === 'heading');
  const titleIsH1 = h1Count === 1 && firstHeading?.type === 'heading' && firstHeading.depth === 1;

  const sections: Section[] = [];
  const stack: Section[] = [];
  let current: Section | null = null;
  let offset = 0;

  const lineAt = (pos: number) => {
    let n = 1;
    for (let i = 0; i < pos && i < markdown.length; i++) if (markdown.charCodeAt(i) === 10) n++;
    return n;
  };

  for (const token of tokens) {
    const start = markdown.indexOf(token.raw, offset);
    const pos = start >= 0 ? start : offset;
    offset = pos + token.raw.length;

    if (token.type === 'heading') {
      if (titleIsH1 && token.depth === 1) {
        current = null;
        continue;
      }
      while (stack.length && stack[stack.length - 1]!.depth >= token.depth) stack.pop();
      const text = stripInline(token.text);
      const m = EXPLICIT_ID.exec(text);
      const heading = m ? m[2]!.trim() : text;
      const parentIgnored = stack.some((s) => s.ignored);
      const section: Section = {
        depth: token.depth,
        heading,
        explicitId: m?.[1],
        path: stack.map((s) => s.heading),
        line: lineAt(pos),
        body: [],
        ignored: parentIgnored || ignore.some((re) => re.test(heading)),
      };
      stack.push(section);
      sections.push(section);
      current = section;
    } else if (current && token.type !== 'space') {
      current.body.push(token.raw.trimEnd());
    }
  }

  const used = new Map<string, number>();
  const requirements: Requirement[] = [];
  for (const s of sections) {
    if (s.ignored) continue;
    const body = s.body.join('\n\n').trim();
    if (!body) continue;
    // Section numbers ("2.1 Login") are left out of ids so renumbering keeps ids stable.
    let id = s.explicitId ?? slugify(s.heading.replace(/^\d+(?:\.\d+)*\.?\s+/, ''));
    const seen = used.get(id) ?? 0;
    used.set(id, seen + 1);
    if (seen > 0) {
      // Prefer the parent's slug to disambiguate, then a counter.
      const parent = s.path.length ? `${slugify(s.path[s.path.length - 1]!)}-${id}` : undefined;
      id = parent && !used.has(parent) ? parent : `${id}-${seen + 1}`;
      used.set(id, 1);
    }
    requirements.push({
      id,
      heading: s.heading,
      path: s.path,
      body,
      source: { file: opts.file ?? '', line: s.line },
    });
  }
  return requirements;
}

/** The text used to embed and judge a requirement. */
export function requirementText(req: Requirement): string {
  const title = [...req.path, req.heading].join(' › ');
  return `${title}\n\n${req.body}`;
}

/**
 * Focused search queries for a requirement: one per list item. A requirement that
 * enumerates several behaviours ("res.json…, res.send…, res.status…") is searched
 * item by item, so each behaviour gets its own chance to retrieve its code.
 */
export function subQueries(req: Requirement, max = 10): string[] {
  const items: string[] = [];
  for (const line of req.body.split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) items.push(stripInline(m[1]!));
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${stripInline(line)}`;
  }
  return items.filter((t) => t.length >= 8).slice(0, max).map((t) => `${req.heading}: ${t}`);
}
