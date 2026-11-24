import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

interface Line {
  text: string;
  size: number;
  y: number;
  page: number;
}

interface TextItemLike {
  str: string;
  transform: number[];
  height: number;
  hasEOL?: boolean;
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+\S/;

/** Extract text lines from a PDF with their font size and vertical position. */
async function extractLines(data: Uint8Array): Promise<Line[]> {
  const task = getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const lines: Line[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      let current: Line | null = null;
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const item = raw as TextItemLike;
        const y = item.transform[5] ?? 0;
        const size = Math.abs(item.transform[3] ?? item.height ?? 0) || item.height;
        // A new line starts when the baseline moves noticeably.
        if (current && Math.abs(current.y - y) > Math.max(2, size * 0.4)) {
          lines.push(current);
          current = null;
        }
        if (!current) current = { text: '', size, y, page: pageNo };
        current.text += item.str;
        current.size = Math.max(current.size, size);
        if (item.hasEOL) {
          lines.push(current);
          current = null;
        }
      }
      if (current) lines.push(current);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text.length > 0);
}

/** The font size that carries the most characters, i.e. body text. */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const s = Math.round(l.size * 2) / 2;
    weight.set(s, (weight.get(s) ?? 0) + l.text.length);
  }
  let best = 0;
  let bestW = -1;
  for (const [s, w] of weight) {
    if (w > bestW) {
      best = s;
      bestW = w;
    }
  }
  return best || 10;
}

function looksLikeHeadingText(text: string): boolean {
  return text.length <= 120 && !/[.;,:]$/.test(text) && /[A-Za-z]/.test(text);
}

/**
 * Convert PDF text to Markdown. Headings are inferred from font size (lines
 * noticeably larger than body text) and from numbered headings like "3.2 Login".
 */
export async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  const lines = await extractLines(data);
  if (lines.length === 0) return '';
  const body = bodySize(lines);

  const headingSizes = [
    ...new Set(
      lines
        .filter((l) => l.size >= body * 1.15 && looksLikeHeadingText(l.text))
        .map((l) => Math.round(l.size * 2) / 2),
    ),
  ].sort((a, b) => b - a);
  const levelForSize = (size: number) => {
    const idx = headingSizes.indexOf(Math.round(size * 2) / 2);
    return Math.min(6, idx + 1);
  };

  const out: string[] = [];
  let paragraph: string[] = [];
  let prev: Line | null = null;
  const flush = () => {
    if (paragraph.length) out.push(paragraph.join(' '), '');
    paragraph = [];
  };

  for (const line of lines) {
    const sizeHeading = line.size >= body * 1.15 && looksLikeHeadingText(line.text);
    const numbered = NUMBERED_HEADING.exec(line.text);
    const numberedHeading = !sizeHeading && numbered && line.text.length <= 80 && looksLikeHeadingText(line.text);

    if (sizeHeading || numberedHeading) {
      flush();
      const level = sizeHeading
        ? levelForSize(line.size)
        : Math.min(6, headingSizes.length + numbered![1]!.split('.').length);
      out.push(`${'#'.repeat(level)} ${line.text}`, '');
    } else if (/^([•▪◦‣\-*]|\d+[.)])\s+/.test(line.text)) {
      flush();
      out.push(`- ${line.text.replace(/^([•▪◦‣\-*]|\d+[.)])\s+/, '')}`);
    } else {
      // A large vertical gap or a page break ends the paragraph.
      const gap = prev && prev.page === line.page ? Math.abs(prev.y - line.y) : Infinity;
      if (paragraph.length && gap > line.size * 1.8) flush();
      paragraph.push(line.text);
    }
    prev = line;
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
