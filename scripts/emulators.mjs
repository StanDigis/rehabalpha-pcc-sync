import { spawn } from 'node:child_process';
import { emulatorEnv, EMULATOR_PROJECT_ID } from './lib/emulator-env.mjs';

const child = spawn(
  'npx',
  ['firebase', 'emulators:start', '--only', 'auth,firestore', '--project', EMULATOR_PROJECT_ID],
  { stdio: 'inherit', env: emulatorEnv() },
);

child.on('exit', (code) => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
