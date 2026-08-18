import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'apps/web');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, env: process.env });
  return result.status ?? 1;
}

const seedStatus = run('tsx', [join(root, 'scripts/seed.ts')], root);
if (seedStatus !== 0) process.exit(seedStatus);

const testStatus = run('npx', ['playwright', 'test'], webRoot);
process.exit(testStatus);
