import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Package version, read from package.json (works from src/ and dist/). */
export const VERSION: string = (require('../package.json') as { version: string }).version;
