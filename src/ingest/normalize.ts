import { readFile } from 'fs/promises';
import { extname } from 'path';
import mammoth from 'mammoth';
// @ts-ignore — pdf-parse has no up-to-date types but works fine
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Converts a spec document of any supported format to a Markdown string.
 * Supported: .md (passthrough), .pdf, .docx
 */
export async function normalizeToMarkdown(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.markdown') {
    return readFile(filePath, 'utf-8');
  }

  if (ext === '.pdf') {
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text as string;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  throw new Error(
    `Unsupported spec format: "${ext}". Supported formats: .md, .pdf, .docx`,
  );
}
