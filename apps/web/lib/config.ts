export const DEFAULT_THERAPY_ORG_ID = process.env['NEXT_PUBLIC_THERAPY_ORG_ID'] ?? 'org_healthpro';

export const isEmulator =
  process.env['FIRESTORE_EMULATOR_HOST'] !== undefined ||
  process.env['NEXT_PUBLIC_USE_FIREBASE_EMULATOR'] === 'true';

export const firebaseClientConfig = {
  apiKey: process.env['NEXT_PUBLIC_FIREBASE_API_KEY'] ?? 'demo-api-key',
  authDomain: process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'] ?? 'demo.firebaseapp.com',
  projectId:
    process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] ??
    process.env['GCLOUD_PROJECT'] ??
    'rehabalpha-pcc-sync-demo',
};
