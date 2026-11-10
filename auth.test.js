import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { passwordGate } from './auth.js';

test('hosted routes require the correct credentials, while health stays accessible', async () => {
  const app = express();
  app.use(passwordGate('test-secret'));
  app.get('/healthz', (req, res) => res.send('ok'));
  app.get('/', (req, res) => res.send('private page'));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, {headers:{Authorization:'Basic !!!'}})).status, 401);
    for (const [credential, status] of [['wrong:test-secret',401], ['sunodlc:wrong',401], ['sunodlc:test-secret',200]]) {
      const response = await fetch(base, {headers:{Authorization:`Basic ${Buffer.from(credential).toString('base64')}`}});
      assert.equal(response.status, status);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
