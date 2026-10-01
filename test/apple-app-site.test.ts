import 'reflect-metadata';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/main.js';
import { appleAppSiteAssociation } from '../server/apple-app-site.js';
import { AccountRegistry } from '../src/accounts.js';

describe('apple-app-site-association', () => {
  it('lists the paid-team app by default and takes an override list', () => {
    expect(appleAppSiteAssociation({})).toEqual({ webcredentials: { apps: ['Z4NCYN9LKJ.id.val.x056'] } });
    expect(appleAppSiteAssociation({ X056_IOS_APP_IDS: ' A.b , C.d ,' }).webcredentials.apps).toEqual(['A.b', 'C.d']);
  });

  it('is served as JSON with no auth and no redirect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-aasa-')), stateDir = join(root, 'state'), workspaceRoot = join(root, 'ws');
    mkdirSync(stateDir); mkdirSync(workspaceRoot);
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'account') }]);
    const app = await createApp({ token: 'aasa-test-token-0123456789abcdef', stateDir, workspaceRoot, projectSpacesEnabled: false });
    try {
      await app.listen(0, '127.0.0.1');
      const res = await fetch((await app.getUrl()) + '/.well-known/apple-app-site-association', { redirect: 'manual' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ webcredentials: { apps: ['Z4NCYN9LKJ.id.val.x056'] } });
    } finally {
      await app.close();
    }
  }, 30_000);
});
