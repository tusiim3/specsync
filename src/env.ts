import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Load KEY=value pairs from a .env file into process.env without overriding
 * variables that are already set. Supports quotes, `export` prefixes and comments.
 */
export function loadDotenv(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = resolve(dir, '.env');
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (env[key] === undefined) env[key] = value;
  }
}
