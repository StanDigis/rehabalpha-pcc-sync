import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID =
  process.env['GCLOUD_PROJECT'] ??
  process.env['GOOGLE_CLOUD_PROJECT'] ??
  'rehabalpha-pcc-sync-demo';

let app: App | undefined;

export function getAdminApp(): App {
  if (app !== undefined) return app;
  app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
  return app;
}

export function getAdminDb() {
  return getFirestore(getAdminApp());
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}
