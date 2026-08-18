import { resolveJavaHome } from './java.mjs';

export const EMULATOR_PROJECT_ID = 'rehabalpha-pcc-sync-demo';
export const FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
export const AUTH_EMULATOR_HOST = '127.0.0.1:9099';

/**
 * Every emulator-backed process needs the same env. Centralising it keeps the
 * npm scripts, the seed script and CI from drifting apart.
 */
export function emulatorEnv() {
  const javaHome = resolveJavaHome();

  return {
    ...process.env,
    JAVA_HOME: javaHome,
    // firebase-tools runs `java` from PATH and does not consult JAVA_HOME, so setting only
    // JAVA_HOME leaves a version manager's older JDK in front and the emulator refuses to start
    // with a message that points at the JDK rather than at the PATH.
    PATH: `${javaHome}/bin:${process.env.PATH ?? ''}`,
    GCLOUD_PROJECT: EMULATOR_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT: EMULATOR_PROJECT_ID,
    FIREBASE_PROJECT_ID: EMULATOR_PROJECT_ID,
    FIRESTORE_EMULATOR_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
    // The reference implementation must never reach the real PointClickCare API from a
    // developer machine or CI. The client refuses to start unless this is explicitly unset.
    PCC_TRANSPORT: process.env.PCC_TRANSPORT ?? 'fixture',
  };
}
