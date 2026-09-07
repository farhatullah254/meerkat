import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JWT } from 'google-auth-library';
import { ROOT } from './paths.js';

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

let client = null;
let serviceAccountEmail = null;

function keyPath() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json';
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

export function loadCredentials() {
  if (client) return client;

  const file = keyPath();
  let key;
  try {
    key = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Service account key not found at ${file}. ` +
          `Download the JSON key from Google Cloud and set GOOGLE_APPLICATION_CREDENTIALS in .env.`
      );
    }
    throw new Error(`Could not read service account key at ${file}: ${err.message}`);
  }

  if (!key.client_email || !key.private_key) {
    throw new Error(`${file} is not a service account key (missing client_email/private_key).`);
  }

  serviceAccountEmail = key.client_email;
  client = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  return client;
}

export function getServiceAccountEmail() {
  if (!serviceAccountEmail) loadCredentials();
  return serviceAccountEmail;
}

async function accessToken() {
  const jwt = loadCredentials();
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error('Google returned an empty access token.');
  return token;
}

/**
 * Google's APIs bury the useful part of a failure inside error.message.
 * Surface it verbatim so a 403 reads as "you forgot to add the service
 * account to this property" rather than "Request failed".
 */
export async function googlePost(url, body) {
  const token = await accessToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body; fall through to the raw text */
  }

  if (!res.ok) {
    const detail = json?.error?.message || text.slice(0, 300) || res.statusText;
    const err = new Error(`${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }

  return json ?? {};
}
