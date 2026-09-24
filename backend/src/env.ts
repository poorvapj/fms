// Cross-platform launcher that selects the environment before anything loads.
// Usage: node src/env.ts <local|live> <script.ts> [args...]
//   e.g. node src/env.ts live src/index.ts
// Loads backend/.env (MONGODB_URI_LOCAL / MONGODB_URI_LIVE, secrets) when present; real environment variables win.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , env, script, ...rest] = process.argv;
if (!env || !['local', 'live'].includes(env) || !script) {
  console.error('Usage: node src/env.ts <local|live> <script.ts> [args...]');
  process.exit(1);
}
process.env.FMS_ENV = env;
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const target = path.resolve(script);
// Make the target script see itself as the entry point (argv[1]) with its own arguments.
process.argv = [process.argv[0], target, ...rest];
await import(pathToFileURL(target).href);
