import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createDatabase } from './db.js';
import { scenarios } from './scenarios.js';
import { mockChat } from './providers/mock.js';
import { foundryChat } from './providers/foundry.js';
import { getRecentLogs, subscribeLogs } from './logs.js';
import { getStatus as getEvalStatus, installToolkit, configureToolkitEnv, saveDataset, readDataset, runEvaluation, findLatestReport, openReport, subscribeEval, listAccountDeployments, deployModel, RECOMMENDED_MODELS, listToolkitDatasets, listSampleDatasets, stopEvaluation, TOOLKIT_DIR } from './eval.js';

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

function parseJudgeJson(text) {
  if (!text) return { accuracy: null, helpfulness: null, notes: 'Empty judge response' };
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  try {
    const obj = JSON.parse(raw);
    const clamp = (n) => (Number.isFinite(Number(n)) ? Math.max(1, Math.min(5, Math.round(Number(n)))) : null);
    return { accuracy: clamp(obj.accuracy), helpfulness: clamp(obj.helpfulness), notes: String(obj.notes || '').slice(0, 200) };
  } catch {
    return { accuracy: null, helpfulness: null, notes: 'Judge returned unparsable output' };
  }
}

// Best-effort fetch from Azure's public Retail Prices API. Returns per-model input/output USD-per-1M-tokens
// alongside the SKU/meter name so the UI can show provenance. Silently drops rows we cannot parse.
async function fetchAzureRetailPricing() {
  const filter = "serviceName eq 'Cognitive Services' and priceType eq 'Consumption' and currencyCode eq 'USD'";
  const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
  const rows = [];
  let next = url;
  let pages = 0;
  while (next && pages < 20) {
    const res = await fetch(next, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Azure Retail Prices API returned HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body.Items)) rows.push(...body.Items);
    next = body.NextPageLink || null;
    pages++;
  }
  // Map to a compact catalog keyed by lower-cased normalized name.
  const models = {};
  const modelHint = /(gpt-[\d.]+[a-z-]*|claude-[a-z0-9-]+|grok-[\d.]+[a-z-]*|deepseek[-a-z0-9.]*|llama-[\d.]+[a-z0-9-]*|o[3-9]-[a-z-]+|phi-[\d.]+[a-z-]*)/i;
  for (const r of rows) {
    const meter = String(r.meterName || '').toLowerCase();
    const isInput = /(input|prompt)/.test(meter) && !/(cached|batch)/.test(meter);
    const isOutput = /(output|completion)/.test(meter) && !/(cached|batch)/.test(meter);
    if (!isInput && !isOutput) continue;
    const productName = String(r.productName || '').toLowerCase();
    const hint = modelHint.exec(productName) || modelHint.exec(meter);
    if (!hint) continue;
    const key = hint[1].toLowerCase();
    if (!models[key]) models[key] = { key, input: null, output: null, sample: { productName: r.productName, meterName: r.meterName, region: r.armRegionName, unitOfMeasure: r.unitOfMeasure } };
    // Azure lists per-1K tokens usually; normalise to per-1M for the app's PRICING catalog.
    const per1k = Number(r.unitPrice) || 0;
    const perMillion = /1k tokens|per 1k/i.test(r.unitOfMeasure || '') ? per1k * 1000 : per1k;
    if (isInput && (models[key].input == null || perMillion < models[key].input)) models[key].input = perMillion;
    if (isOutput && (models[key].output == null || perMillion < models[key].output)) models[key].output = perMillion;
  }
  return Object.values(models).filter((m) => m.input != null || m.output != null);
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
        // Derive the resource name from the endpoint if the wizard didn't write it explicitly.
        let foundryName = process.env.AZURE_FOUNDRY_RESOURCE_NAME || null;
        if (!foundryName && process.env.AZURE_OPENAI_ENDPOINT) {
          const match = /https?:\/\/([^./]+)/.exec(process.env.AZURE_OPENAI_ENDPOINT);
          if (match) foundryName = match[1];
        }
        const foundry = {
          name: foundryName,
          resourceGroup: process.env.AZURE_FOUNDRY_RESOURCE_GROUP || null,
          endpoint: process.env.AZURE_OPENAI_ENDPOINT || null
        };
        return sendJson(response, 200, { provider: providerName, deployments, foundry });
      }
      if (url.pathname === '/api/scenarios' && request.method === 'GET') return sendJson(response, 200, scenarios);
      if (url.pathname === '/api/conversations' && request.method === 'GET') return sendJson(response, 200, database.listConversations());
      if (url.pathname === '/api/conversations' && request.method === 'POST') {
        const body = await readJson(request);
        return sendJson(response, 201, database.createConversation(typeof body.title === 'string' ? body.title : undefined));
      }
      if (url.pathname === '/api/analytics' && request.method === 'GET') return sendJson(response, 200, database.getAnalytics(url.searchParams.get('conversationId') || undefined, url.searchParams.get('baseline') || undefined));
      if (url.pathname === '/api/pricing/live' && request.method === 'GET') {
        try {
          const models = await fetchAzureRetailPricing();
          return sendJson(response, 200, { models, source: 'https://prices.azure.com/api/retail/prices', fetchedAt: new Date().toISOString() });
        } catch (error) {
          return sendJson(response, 500, { error: String(error?.message || error) });
        }
      }
      if (url.pathname === '/api/data' && request.method === 'DELETE') { database.clearAll(); return sendJson(response, 200, { ok: true }); }

      if (url.pathname === '/api/setup/launch' && request.method === 'POST') {
        try {
          const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
          const setupScript = join(rootDir, 'scripts', 'setup-server.js');
          if (!existsSync(setupScript)) {
            return sendJson(response, 500, { error: `Setup wizard script not found at ${setupScript}` });
          }
          const alreadyUp = await fetch('http://127.0.0.1:3100/', { signal: AbortSignal.timeout(600) })
            .then((r) => r.ok || r.status === 404).catch(() => false);
          if (alreadyUp) {
            return sendJson(response, 200, { ok: true, url: 'http://localhost:3100/', reused: true });
          }
          const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', setupScript], {
            cwd: rootDir,
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, AZURE_LOGIN_EXPERIENCE_V2: 'off' }
          });
          child.on('error', () => { /* detached, ignore */ });
          child.unref();
          return sendJson(response, 200, { ok: true, url: 'http://localhost:3100/' });
        } catch (error) {
          return sendJson(response, 500, { error: String(error?.message || error) });
        }
      }

      const scoreMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/score$/);
      if (scoreMatch && request.method === 'POST') {
        const conversationId = scoreMatch[1];
        const conversation = database.getConversation(conversationId);
        if (!conversation) return sendJson(response, 404, { error: 'Conversation not found' });
        const body = await readJson(request);
        const judgeDeployment = String(body.judgeDeployment || '').trim();
        if (!judgeDeployment) return sendJson(response, 400, { error: 'judgeDeployment is required' });
        const results = [];
        const messages = conversation.messages || [];
        for (let i = 0; i < messages.length - 1; i += 1) {
          const user = messages[i];
          const assistant = messages[i + 1];
          if (user.role !== 'user' || assistant.role !== 'assistant' || !assistant.content) continue;
          const judgePrompt = `You are a strict quality judge. Rate the assistant response below on two 1-5 scales.\n\n===PROMPT===\n${user.content}\n\n===RESPONSE===\n${assistant.content}\n\nReturn ONLY compact JSON with keys accuracy (1-5 integer), helpfulness (1-5 integer), notes (one short sentence). No prose outside the JSON.`;
          try {
            const judgment = await foundryChat({
              messages: [{ role: 'user', content: judgePrompt }],
              complexityLevel: 1,
              routingMode: 'balanced',
              deploymentOverride: judgeDeployment
            });
            const parsed = parseJudgeJson(judgment.content);
            database.saveQualityScore(assistant.id, { ...parsed, judge: judgeDeployment });
            results.push({ messageId: assistant.id, ...parsed });
          } catch (error) {
            results.push({ messageId: assistant.id, error: error.message });
          }
        }
        return sendJson(response, 200, { scored: results.length, results });
      }

      if (url.pathname === '/api/eval/status' && request.method === 'GET') return sendJson(response, 200, getEvalStatus());
      if (url.pathname === '/api/eval/toolkit-datasets' && request.method === 'GET') return sendJson(response, 200, { datasets: listToolkitDatasets() });
      if (url.pathname === '/api/eval/sample-datasets' && request.method === 'GET') return sendJson(response, 200, { datasets: listSampleDatasets() });
      if (url.pathname === '/api/eval/dataset-content' && request.method === 'GET') {
        try {
          const result = readDataset(url.searchParams.get('path'));
          return sendJson(response, 200, result);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/dataset-download' && request.method === 'GET') {
        try {
          const result = readDataset(url.searchParams.get('path'));
          const contentType = result.name.endsWith('.csv') ? 'text/csv; charset=utf-8'
            : result.name.endsWith('.json') ? 'application/json; charset=utf-8'
            : result.name.endsWith('.jsonl') ? 'application/jsonl; charset=utf-8'
            : 'text/plain; charset=utf-8';
          response.writeHead(200, {
            'content-type': contentType,
            'content-disposition': `attachment; filename="${result.name.replace(/"/g, '')}"`,
            'cache-control': 'no-cache'
          });
          response.end(result.content);
          return;
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const unsubscribe = subscribeEval((entry) => response.write(`data: ${JSON.stringify(entry)}\n\n`));
        request.on('close', unsubscribe);
        return;
      }
      if (url.pathname === '/api/eval/install' && request.method === 'POST') {
        installToolkit().catch(() => {});
        return sendJson(response, 202, { started: true });
      }
      if (url.pathname === '/api/eval/configure' && request.method === 'POST') {
        const body = await readJson(request);
        const routerEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
        const routerDeployment = process.env.MODEL_ROUTER_DEPLOYMENT_BALANCED || process.env.MODEL_ROUTER_DEPLOYMENT_NAME;
        const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
        try {
          configureToolkitEnv({ routerEndpoint, routerDeployment, apiKey, apiVersion, ...body });
          return sendJson(response, 200, { ok: true });
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/dataset' && request.method === 'POST') {
        const body = await readJson(request);
        try {
          const path = saveDataset(body.name || 'prompts.jsonl', body.content || '');
          return sendJson(response, 200, { path });
        } catch (error) {
          return sendJson(response, 500, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/run' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body.datasetPath) return sendJson(response, 400, { error: 'datasetPath is required' });
        runEvaluation({
          datasetPath: body.datasetPath,
          config: body.config,
          dryRun: body.dryRun,
          runName: body.runName,
          db: database,
          routerDeployment: body.routerDeployment,
          baselineDeployment: body.baselineDeployment,
          judgeDeployment: body.judgeDeployment
        }).catch(() => {});
        return sendJson(response, 202, { started: true });
      }
      if (url.pathname === '/api/eval/history' && request.method === 'GET') {
        return sendJson(response, 200, { runs: database.listEvalRuns() });
      }
      if (url.pathname === '/api/eval/stop' && request.method === 'POST') {
        return sendJson(response, 200, stopEvaluation());
      }
      if (url.pathname === '/api/eval/report' && request.method === 'GET') {
        const report = findLatestReport();
        return sendJson(response, 200, { report });
      }
      if (url.pathname === '/api/eval/open-report' && request.method === 'POST') {
        try {
          const path = openReport();
          return sendJson(response, 200, { path });
        } catch (error) {
          return sendJson(response, 404, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/deployments' && request.method === 'GET') {
        try {
          const deployments = await listAccountDeployments();
          return sendJson(response, 200, { deployments, recommended: RECOMMENDED_MODELS });
        } catch (error) {
          return sendJson(response, 500, { error: error.message });
        }
      }
      if (url.pathname === '/api/eval/deploy' && request.method === 'POST') {
        const body = await readJson(request);
        deployModel(body).catch(() => {});
        return sendJson(response, 202, { started: true });
      }

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