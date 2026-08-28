import { lexer, type Token } from 'marked';
import type { Requirement } from '../types.js';

/** Convert a heading string to a stable URL-safe slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Split a Markdown string into Requirement objects, one per heading (## or ###).
 * Content before the first heading is attached to a synthetic "preamble" requirement.
 */
export function splitSections(markdown: string): Requirement[] {
  const tokens: Token[] = lexer(markdown);
  const requirements: Requirement[] = [];

  let currentHeading: string | null = null;
  let bodyTokens: string[] = [];

  const flush = (): void => {
    if (currentHeading === null) return;
    const body = bodyTokens.join('\n').trim();
    if (!body && requirements.length > 0) return; // skip empty sections
    requirements.push({
      id: slugify(currentHeading),
      heading: currentHeading,
      body,
    });
    bodyTokens = [];
  };

  for (const token of tokens) {
    if (token.type === 'heading' && token.depth >= 2 && token.depth <= 3) {
      flush();
      currentHeading = token.text;
    } else if (currentHeading !== null) {
      // Reconstruct plain text from token
      if ('text' in token && typeof token.text === 'string') {
        bodyTokens.push(token.text);
      } else if (token.type === 'list' && 'items' in token) {
        for (const item of token.items) {
          bodyTokens.push(`- ${item.text}`);
        }
      } else if (token.type === 'code' && 'text' in token) {
        bodyTokens.push(token.text);
      }
    }
  }

  flush();
  return requirements;
}
