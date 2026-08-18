'use client';

import { initializeApp, getApps } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { firebaseClientConfig, isEmulator } from '@/lib/config';

let authEmulatorConnected = false;

export function getClientAuth() {
  const app = getApps()[0] ?? initializeApp(firebaseClientConfig);
  const auth = getAuth(app);

  if (isEmulator && !authEmulatorConnected) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    authEmulatorConnected = true;
  }

  return auth;
}
