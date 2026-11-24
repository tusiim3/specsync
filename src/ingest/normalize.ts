import { readFile } from 'fs/promises';
import { extname } from 'path';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { pdfToMarkdown } from './pdf.js';

export const SPEC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.docx', '.pdf', '.html', '.htm'];

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  return td.turndown(html);
}

/**
 * Convert a spec document to Markdown, keeping its heading structure so
 * sections can be split into requirements.
 */
export async function normalizeToMarkdown(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.md':
    case '.markdown':
    case '.mdx':
    case '.txt':
      return readFile(filePath, 'utf-8');
    case '.html':
    case '.htm':
      return htmlToMarkdown(await readFile(filePath, 'utf-8'));
    case '.docx': {
      // convertToHtml maps Word heading styles to <h1>..<h6>, which survive into Markdown.
      const { value } = await mammoth.convertToHtml({ path: filePath });
      return htmlToMarkdown(value);
    }
    case '.pdf':
      return pdfToMarkdown(new Uint8Array(await readFile(filePath)));
    default:
      throw new Error(
        `Unsupported spec format "${ext || filePath}". Supported: ${SPEC_EXTENSIONS.join(', ')}`,
      );
  }
}
