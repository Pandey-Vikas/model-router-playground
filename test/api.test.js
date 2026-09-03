import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/server.js';

async function startTestApp() {
  const database = createDatabase(':memory:');
  const { server } = createApp({ database, providerName: 'mock' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: async () => { await new Promise((resolve) => server.close(resolve)); database.close(); }
  };
}

test('stores routing telemetry and updates the conversation title', async () => {
  const app = await startTestApp();
  try {
    const conversation = await fetch(`${app.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }).then((response) => response.json());
    const assistant = await fetch(`${app.baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Design a retry strategy', complexityLevel: 6 })
    }).then((response) => response.json());

    assert.equal(assistant.routed_model, 'gpt-5-mini');
    assert.equal(assistant.complexity_level, 6);
    assert.ok(assistant.total_tokens > 0);
    const saved = await fetch(`${app.baseUrl}/api/conversations/${conversation.id}`).then((response) => response.json());
    assert.equal(saved.title, 'Design a retry strategy');
    assert.equal(saved.messages.length, 2);
  } finally {
    await app.close();
  }
});

test('rejects invalid complexity levels', async () => {
  const app = await startTestApp();
  try {
    const conversation = await fetch(`${app.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }).then((response) => response.json());
    const response = await fetch(`${app.baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hello', complexityLevel: 16 })
    });
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});