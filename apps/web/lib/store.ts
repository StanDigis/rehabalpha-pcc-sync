import { SyncStore } from '@rehabalpha/sync';
import { getAdminDb } from './firebase-admin';

let store: SyncStore | undefined;

export function getStore(): SyncStore {
  store ??= new SyncStore(getAdminDb());
  return store;
}
