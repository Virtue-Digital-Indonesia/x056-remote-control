// A TEST-ONLY passkey shared by fixture.ts (X056_TEST_STORAGE=1, which stores
// its public half as the fixture's one approver) and storage-sweeper.cjs
// (which loads the private half into Chromium's virtual authenticator). It
// protects nothing: it exists only in throwaway fixture state dirs.
const { createPrivateKey, createPublicKey } = require('node:crypto');

const credentialId = 'IyfzTG51dY8SNYI0yl3M6g';
const pkcs8 = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgADqUE1+HD25h40OBs1V2RQC7VowsScg8e//sRp+bZyuhRANCAATUPaVsEheTq1Z3u1BrpHP9sQ9t4VmuY6qzDWOnZoC7Z903zxb4ZAtG55jWTAhpCeuu3904yVnt+RL2EMjUwvug';

/** The public key as @simplewebauthn/server stores it: COSE, base64url. */
function coseB64url() {
  const pub = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' }));
  const jwk = pub.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
}

module.exports = { credentialId, pkcs8, coseB64url };
