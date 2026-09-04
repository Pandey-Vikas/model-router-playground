import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { scenarios } from './scenarios.js';
import { mockChat } from './providers/mock.js';
import { foundryChat } from './providers/foundry.js';
import { getRecentLogs, subscribeLogs } from './logs.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 100_000) throw new Error('Request body is too large');
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function createApp({ database = createDatabase(), providerName = process.env.MODEL_PROVIDER || 'mock' } = {}) {
  const provider = providerName === 'foundry' ? foundryChat : mockChat;
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const fallback = process.env.MODEL_ROUTER_DEPLOYMENT_NAME || null;
        const deployments = {
          balanced: process.env.MODEL_ROUTER_DEPLOYMENT_BALANCED || fallback,
          cost: process.env.MODEL_ROUTER_DEPLOYMENT_COST || fallback,
          quality: process.env.MODEL_ROUTER_DEPLOYMENT_QUALITY || fallback
        };
        return sendJson(response, 200, { provider: providerName, deployments });
      }
      if (url.pathname === '/api/scenarios' && request.method === 'GET') return sendJson(response, 200, scenarios);
      if (url.pathname === '/api/conversations' && request.method === 'GET') return sendJson(response, 200, database.listConversations());
      if (url.pathname === '/api/conversations' && request.method === 'POST') {
        const body = await readJson(request);
        return sendJson(response, 201, database.createConversation(typeof body.title === 'string' ? body.title : undefined));
      }
      if (url.pathname === '/api/analytics' && request.method === 'GET') return sendJson(response, 200, database.getAnalytics(url.searchParams.get('conversationId') || undefined));
      if (url.pathname === '/api/data' && request.method === 'DELETE') { database.clearAll(); return sendJson(response, 200, { ok: true }); }

      if (url.pathname === '/api/logs' && request.method === 'GET') return sendJson(response, 200, getRecentLogs());
      if (url.pathname === '/api/logs/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const entry of getRecentLogs()) response.write(`data: ${JSON.stringify(entry)}\n\n`);
        const unsubscribe = subscribeLogs((entry) => response.write(`data: ${JSON.stringify(entry)}\n\n`));
        request.on('close', unsubscribe);
        return;
      }

      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/);
      if (conversationMatch && request.method === 'GET') {
        const conversation = database.getConversation(conversationMatch[1]);
        return conversation ? sendJson(response, 200, conversation) : sendJson(response, 404, { error: 'Conversation not found' });
      }
      if (conversationMatch && request.method === 'DELETE') {
        return sendJson(response, database.deleteConversation(conversationMatch[1]) ? 204 : 404, {});
      }

      const messageMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/);
      if (messageMatch && request.method === 'POST') {
        const conversationId = messageMatch[1];
        const conversation = database.getConversation(conversationId);
        if (!conversation) return sendJson(response, 404, { error: 'Conversation not found' });
        const body = await readJson(request);
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        const complexityLevel = Number(body.complexityLevel);
        if (!content || content.length > 12_000) return sendJson(response, 400, { error: 'Message must contain 1 to 12,000 characters' });
        if (!Number.isInteger(complexityLevel) || complexityLevel < 1 || complexityLevel > 30) return sendJson(response, 400, { error: 'Complexity level must be from 1 to 30' });

        database.addMessage(conversationId, { role: 'user', content, complexityLevel });
        const current = database.getConversation(conversationId);
        const historyMessages = current.messages.map(({ role, content: text }) => ({ role, content: text }));
        const routingMode = ['balanced', 'cost', 'quality'].includes(body.routingMode) ? body.routingMode : 'balanced';
        const messages = body.noHistory ? [{ role: 'user', content }] : historyMessages;
        const result = await provider({ messages, complexityLevel, routingMode });
        const assistant = database.addMessage(conversationId, { role: 'assistant', complexityLevel, ...result });
        return sendJson(response, 201, assistant);
      }

      if (request.method !== 'GET') return sendJson(response, 404, { error: 'Not found' });
      const requestedFile = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (requestedFile.includes('..')) return sendJson(response, 400, { error: 'Invalid path' });
      const file = readFileSync(join(publicDirectory, requestedFile));
      response.writeHead(200, { 'content-type': mimeTypes[extname(requestedFile)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(file);
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 500;
      sendJson(response, status, { error: status === 500 ? 'The request could not be completed' : error.message });
      if (status === 500) console.error(error);
    }
  });
  return { server, database };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync('./data', { recursive: true });
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, () => console.log(`Model Router Playground: http://localhost:${port}`));
  const shutdown = () => app.server.close(() => { app.database.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}