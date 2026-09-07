import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { foundryChat } from './providers/foundry.js';

const listeners = new Set();
let activeBenchmark = null;

function emit(line) {
  const record = { ts: new Date().toISOString(), line };
  for (const listener of listeners) { try { listener(record); } catch { /* ignore */ } }
}

export function subscribeBenchmark(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function isBenchmarkBusy() { return activeBenchmark !== null; }

export function stopBenchmark() {
  if (!activeBenchmark) return { stopped: false, reason: 'No benchmark is running.' };
  activeBenchmark.cancelled = true;
  emit('Benchmark stop requested — will finish in-flight prompts then abort.');
  return { stopped: true };
}

function loadDataset(datasetPath) {
  if (!existsSync(datasetPath)) throw new Error(`Dataset not found: ${datasetPath}`);
  const prompts = [];
  for (const line of readFileSync(datasetPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.prompt && typeof obj.prompt === 'string') prompts.push({
        id: obj.id || `prompt-${prompts.length + 1}`,
        prompt: obj.prompt,
        difficulty: obj.difficulty || null,
        level: Number.isFinite(obj.level) ? obj.level : null,
        // Label priority: explicit title → category → id → null (Compare falls back to prompt snippet).
        label: obj.title || obj.category || obj.id || null
      });
    } catch { /* skip malformed */ }
  }
  return prompts;
}

function difficultyToLevel(d) {
  const s = String(d || '').toLowerCase();
  if (s === 'easy') return 3;
  if (s === 'medium') return 10;
  if (s === 'hard') return 18;
  return null;
}

async function withLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array(Math.min(limit, items.length)).fill(0).map(run));
  return results;
}

export async function runBenchmark({ datasetPath, endpoints, db, concurrency = 2, requestDelayMs = 500 }) {
  if (activeBenchmark) throw new Error('Another benchmark is already running.');
  const cleanEndpoints = (endpoints || []).filter((e) => e && e.deployment);
  if (cleanEndpoints.length < 2) throw new Error('Pick at least two endpoints to benchmark.');
  const prompts = loadDataset(datasetPath);
  if (!prompts.length) throw new Error('Dataset is empty or malformed.');

  const batchId = randomUUID();
  const state = { cancelled: false, batchId };
  activeBenchmark = state;
  emit(`===== QUICK BENCHMARK started (batch ${batchId.slice(0, 8)}) =====`);
  emit(`Dataset: ${datasetPath} · prompts: ${prompts.length} · endpoints: ${cleanEndpoints.length} · concurrency: ${concurrency} · delay: ${requestDelayMs}ms`);
  const conversationIds = [];
  db.createBenchmarkRun({
    id: batchId,
    datasetName: datasetPath.split(/[\\/]/).pop(),
    endpoints: cleanEndpoints.map((e) => ({ label: e.label, deployment: e.deployment, routingMode: e.routingMode })),
    conversationIds: [],
    totalPrompts: prompts.length,
    totalCalls: prompts.length * cleanEndpoints.length
  });
  try {
    for (const endpoint of cleanEndpoints) {
      if (state.cancelled) { emit('Cancelled.'); break; }
      emit(`----- Endpoint: ${endpoint.label} (${endpoint.deployment}) -----`);
      const title = `[Bench ${batchId.slice(0, 8)}] ${endpoint.label} · ${endpoint.deployment}`;
      const conversation = db.createConversation(title);
      conversationIds.push(conversation.id);
      let done = 0, ok = 0, err = 0;
      const started = Date.now();
      const conversationEpoch = Date.now();
      await withLimit(prompts, concurrency, async (p, index) => {
        if (state.cancelled) return;
        // Explicit level from JSONL (built-in scenarios); otherwise 1-based index so every prompt is its own row in the Compare table.
        const level = Number.isFinite(p.level) ? p.level : (index + 1);
        // Deterministic timestamps per prompt index preserve Q/A pair ordering even when workers finish out of order.
        const userTs = new Date(conversationEpoch + index * 2).toISOString();
        const asstTs = new Date(conversationEpoch + index * 2 + 1).toISOString();
        let result = null;
        let errorMsg = null;
        try {
          result = await foundryChat({
            messages: [{ role: 'user', content: p.prompt }],
            routingMode: endpoint.routingMode || 'balanced',
            deploymentOverride: endpoint.deployment,
            source: 'benchmark',
            context: { batchId: batchId.slice(0, 8), endpointLabel: endpoint.label, promptId: p.id }
          });
        } catch (error) {
          errorMsg = error.message;
        }
        db.addMessage(conversation.id, { role: 'user', content: p.prompt, complexityLevel: level, createdAt: userTs, promptLabel: p.label });
        if (result) {
          db.addMessage(conversation.id, { role: 'assistant', complexityLevel: level, createdAt: asstTs, ...result });
          ok++;
        } else {
          db.addMessage(conversation.id, {
            role: 'assistant',
            content: `[error] ${errorMsg}`,
            complexityLevel: level,
            provider: 'foundry',
            finishReason: 'error',
            createdAt: asstTs
          });
          err++;
        }
        done++;
        emit(`  ${endpoint.label}: ${done}/${prompts.length} (${ok} ok, ${err} err)`);
        if (requestDelayMs > 0 && done < prompts.length) {
          await new Promise((r) => setTimeout(r, requestDelayMs));
        }
      });
      const secs = Math.round((Date.now() - started) / 1000);
      emit(`${endpoint.label}: done in ${secs}s (${ok} success, ${err} error)`);
    }
    if (state.cancelled) emit(`===== QUICK BENCHMARK stopped (batch ${batchId.slice(0, 8)}) =====`);
    else emit(`===== QUICK BENCHMARK complete (batch ${batchId.slice(0, 8)}) =====`);
    db.finishBenchmarkRun(batchId, { status: state.cancelled ? 'stopped' : 'success', conversationIds });
    return { batchId, conversationIds };
  } catch (error) {
    db.finishBenchmarkRun(batchId, { status: 'failed', conversationIds, error: error.message });
    throw error;
  } finally {
    activeBenchmark = null;
  }
}
