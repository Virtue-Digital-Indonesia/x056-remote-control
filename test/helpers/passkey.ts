// A software passkey for tests: a P-256 key whose public half is stored the
// way @simplewebauthn/server stores it (COSE), and assertions signed with it.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function coseFromPublicKey(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  return Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
}

export interface TestPasskey { credentialId: string; privateKey: KeyObject; counter: number }

/** Add a passkey to a state dir's webauthn/credentials.json. */
export function addPasskey(stateDir: string, label = 'test passkey', key?: { privateKey: KeyObject; publicKey: KeyObject }, credentialId = randomBytes(16).toString('base64url')): TestPasskey {
  const pair = key ?? generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const file = join(stateDir, 'webauthn', 'credentials.json');
  mkdirSync(join(stateDir, 'webauthn'), { recursive: true });
  let creds: unknown[] = [];
  try { creds = JSON.parse(readFileSync(file, 'utf8')) as unknown[]; } catch { /* first */ }
  creds.push({ id: credentialId, publicKey: coseFromPublicKey(pair.publicKey).toString('base64url'), counter: 0, label, createdAt: Date.now() });
  writeFileSync(file, JSON.stringify(creds));
  return { credentialId, privateKey: pair.privateKey, counter: 0 };
}

/** An authentication response for `challenge`, as a browser would send it. */
export function assertion(pk: TestPasskey, o: { rpID: string; origin: string; challenge: string; uv?: boolean }) {
  pk.counter++;
  const flags = 0x01 | (o.uv === false ? 0 : 0x04);
  const counter = Buffer.alloc(4); counter.writeUInt32BE(pk.counter);
  const authData = Buffer.concat([createHash('sha256').update(o.rpID).digest(), Buffer.from([flags]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: o.origin, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), pk.privateKey);
  return {
    id: pk.credentialId, rawId: pk.credentialId, type: 'public-key' as const, clientExtensionResults: {},
    response: { authenticatorData: authData.toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url'), signature: signature.toString('base64url') },
  };
}
