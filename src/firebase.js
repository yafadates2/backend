import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export function initAdmin(cfg) {
  if (!getApps().length) {
    initializeApp({
      credential: cfg.FIREBASE_SERVICE_ACCOUNT_JSON
        ? cert(JSON.parse(cfg.FIREBASE_SERVICE_ACCOUNT_JSON))
        : applicationDefault(),
    });
  }
  return { auth: getAuth(), db: getFirestore() };
}

export function createTokenVerifier(auth) {
  return (token) => auth.verifyIdToken(token);
}
