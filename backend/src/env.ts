// Cross-platform launcher that selects the database environment before anything loads.
// Usage: node src/env.ts <local|live> <script.ts> [args...]
//   e.g. node src/env.ts live src/index.ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , env, script, ...rest] = process.argv;
if (!env || !['local', 'live'].includes(env) || !script) {
  console.error('Usage: node src/env.ts <local|live> <script.ts> [args...]');
  process.exit(1);
}
process.env.FMS_ENV = env;
const target = path.resolve(script);
// Make the target script see itself as the entry point (argv[1]) with its own arguments.
process.argv = [process.argv[0], target, ...rest];
await import(pathToFileURL(target).href);
