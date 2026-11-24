// Writes schema/specsync.schema.json from the zod config schema, for editor
// autocomplete in specsync.config.json. Run: npm run schema
import { writeFile, mkdir } from 'fs/promises';
import { z } from 'zod';
import { ConfigSchema } from '../src/config.js';

const schema = z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
schema['title'] = 'SpecSync configuration';
(schema['properties'] as Record<string, unknown>)['$schema'] = { type: 'string' };
await mkdir('schema', { recursive: true });
await writeFile('schema/specsync.schema.json', `${JSON.stringify(schema, null, 2)}\n`);
console.log('wrote schema/specsync.schema.json');
