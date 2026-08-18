import { spawn } from 'node:child_process';
import { emulatorEnv } from './lib/emulator-env.mjs';

export function demoWebEnv() {
  return {
    ...emulatorEnv(),
    NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'rehabalpha-pcc-sync-demo',
    OPS_CONSOLE_DEV_BYPASS: '1',
  };
}

const command = process.argv.slice(2);

if (command.length === 0) {
  console.error('usage: node scripts/run-with-env.mjs <command> [args...]');
  process.exit(64);
}

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: demoWebEnv(),
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
