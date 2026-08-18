import { spawn } from 'node:child_process';
import { emulatorEnv, EMULATOR_PROJECT_ID } from './lib/emulator-env.mjs';

const command = process.argv.slice(2);

if (command.length === 0) {
  console.error('usage: node scripts/with-emulators.mjs <command> [...args]');
  process.exit(64);
}

// `emulators:exec` boots the suite, runs the command once against a clean dataset and
// tears everything down, which is what both CI and local test runs want.
const child = spawn(
  'npx',
  [
    'firebase',
    'emulators:exec',
    '--only',
    'auth,firestore',
    '--project',
    EMULATOR_PROJECT_ID,
    command.join(' '),
  ],
  { stdio: 'inherit', env: emulatorEnv() },
);

child.on('exit', (code) => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
