import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { calculateCost, tierFor, BASELINE_MODEL, priceFor } from '../public/pricing.js';

function difficultyToLevel(difficulty) {
  const d = String(difficulty || '').toLowerCase();
  if (d === 'easy') return 3;
  if (d === 'medium') return 10;
  if (d === 'hard') return 18;
  return null;
}

export function createDatabase(filename = process.env.DATABASE_PATH || './data/router-playground.db') {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      complexity_level INTEGER,
      routed_model TEXT,
      provider TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      latency_ms INTEGER,
      finish_reason TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      router_deployment TEXT,
      baseline_deployment TEXT,
      judge_deployment TEXT,
      config TEXT,
      dataset_name TEXT,
      run_dir TEXT,
      dashboard_path TEXT,
      error TEXT,
      summary_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_started ON eval_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      dataset_name TEXT,
      endpoints_json TEXT,
      conversation_ids_json TEXT,
      total_prompts INTEGER,
      total_calls INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at DESC);
  `);

  // Any 'running' rows from a previous process can't still be running — the server just started.
  const nowIso = new Date().toISOString();
  const staleEvalRuns = database.prepare(`UPDATE eval_runs SET status = 'stopped', completed_at = ?, error = COALESCE(error, 'Server restarted while eval was running') WHERE status = 'running'`).run(nowIso);
  const staleBenchmarkRuns = database.prepare(`UPDATE benchmark_runs SET status = 'stopped', completed_at = ?, error = COALESCE(error, 'Server restarted while benchmark was running') WHERE status = 'running'`).run(nowIso);
  if (staleEvalRuns.changes || staleBenchmarkRuns.changes) {
    console.log(`[db] Marked ${staleEvalRuns.changes} eval and ${staleBenchmarkRuns.changes} benchmark rows as stopped (server restart recovery).`);
  }

  // One-time re-numbering: old benchmark conversations used bucketed complexity_level (3/10/18)
  // which collapsed 25 prompts into 3 rows in Compare. Re-assign as 1-based prompt index.
  try {
    const oldBench = database.prepare(`
      SELECT id FROM conversations WHERE title LIKE '[Bench %]%'
        AND id IN (
          SELECT conversation_id FROM messages
          WHERE role = 'user' AND complexity_level IN (3, 10, 18)
          GROUP BY conversation_id
          HAVING COUNT(DISTINCT complexity_level) < COUNT(*)
        )
    `).all();
    if (oldBench.length) {
      const setLevel = database.prepare(`UPDATE messages SET complexity_level = ? WHERE id = ?`);
      const listMsgs = database.prepare(`SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`);
      database.exec('BEGIN');
      try {
        for (const conv of oldBench) {
          const msgs = listMsgs.all(conv.id);
          let promptIdx = 0;
          for (const m of msgs) {
            if (m.role === 'user') promptIdx++;
            setLevel.run(promptIdx, m.id);
          }
        }
        database.exec('COMMIT');
      } catch (e) {
        database.exec('ROLLBACK');
        throw e;
      }
      console.log(`[db] Re-numbered ${oldBench.length} old benchmark conversation(s) so Compare shows one row per prompt.`);
    }
  } catch (error) {
    console.warn('[db] Bench re-numbering skipped:', error.message);
  }

  const existingCols = new Set(database.prepare("PRAGMA table_info(messages)").all().map((r) => r.name));
  const migrations = [
    ['quality_accuracy', 'INTEGER'],
    ['quality_helpfulness', 'INTEGER'],
    ['quality_notes', 'TEXT'],
    ['quality_judge', 'TEXT'],
    ['quality_scored_at', 'TEXT'],
    ['cost_usd', 'REAL'],
    ['input_rate_usd_per_million', 'REAL'],
    ['output_rate_usd_per_million', 'REAL'],
    ['rate_source', 'TEXT'],
    ['prompt_label', 'TEXT']
  ];
  for (const [col, type] of migrations) {
    if (!existingCols.has(col)) database.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
  }

  // Backfill cost_usd for pre-migration assistant rows so historical dashboards still show cost.
  const unpriced = database.prepare(`
    SELECT id, routed_model, prompt_tokens, completion_tokens FROM messages
    WHERE role = 'assistant' AND cost_usd IS NULL AND (prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL)
  `).all();
  if (unpriced.length) {
    const update = database.prepare(`UPDATE messages SET cost_usd = ?, input_rate_usd_per_million = ?, output_rate_usd_per_million = ?, rate_source = ? WHERE id = ?`);
    for (const row of unpriced) {
      const price = priceFor(row.routed_model);
      const cost = ((row.prompt_tokens ?? 0) * price.input + (row.completion_tokens ?? 0) * price.output) / 1_000_000;
      update.run(cost, price.input, price.output, 'backfill', row.id);
    }
  }

  const evalCols = new Set(database.prepare("PRAGMA table_info(eval_runs)").all().map((r) => r.name));
  if (!evalCols.has('batch_id')) database.exec("ALTER TABLE eval_runs ADD COLUMN batch_id TEXT");
  if (!evalCols.has('mode_label')) database.exec("ALTER TABLE eval_runs ADD COLUMN mode_label TEXT");

  const listConversationsStatement = database.prepare(`
    SELECT c.*, COUNT(m.id) AS message_count,
      (SELECT routed_model FROM messages WHERE conversation_id = c.id AND role = 'assistant' ORDER BY created_at DESC LIMIT 1) AS last_model
    FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id ORDER BY c.updated_at DESC
  `);
  const getConversationStatement = database.prepare('SELECT * FROM conversations WHERE id = ?');
  const listMessagesStatement = database.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid');
  const insertConversationStatement = database.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const touchConversationStatement = database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  const setInitialTitleStatement = database.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = 'New conversation'");
  const insertMessageStatement = database.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, complexity_level, routed_model, provider,
      prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, cached_tokens, latency_ms,
      finish_reason, request_id, created_at, cost_usd, input_rate_usd_per_million, output_rate_usd_per_million, rate_source, prompt_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    close: () => database.close(),
    listConversations: () => listConversationsStatement.all(),
    getConversation(id) {
      const conversation = getConversationStatement.get(id);
      return conversation ? { ...conversation, messages: listMessagesStatement.all(id) } : null;
    },
    createConversation(title = 'New conversation') {
      const id = randomUUID();
      const now = new Date().toISOString();
      insertConversationStatement.run(id, title.slice(0, 80), now, now);
      return getConversationStatement.get(id);
    },
    addMessage(conversationId, message) {
      const now = message.createdAt || new Date().toISOString();
      const id = randomUUID();
      if (message.role === 'user') setInitialTitleStatement.run(message.content.slice(0, 80), conversationId);
      let costUsd = null, inputRate = null, outputRate = null, rateSource = null;
      if (message.role === 'assistant' && (message.promptTokens || message.completionTokens)) {
        const price = priceFor(message.routedModel);
        inputRate = price.input;
        outputRate = price.output;
        rateSource = price.source || 'static';
        costUsd = ((message.promptTokens ?? 0) * inputRate + (message.completionTokens ?? 0) * outputRate) / 1_000_000;
      }
      insertMessageStatement.run(
        id, conversationId, message.role, message.content, message.complexityLevel ?? null,
        message.routedModel ?? null, message.provider ?? null, message.promptTokens ?? null,
        message.completionTokens ?? null, message.totalTokens ?? null, message.reasoningTokens ?? null,
        message.cachedTokens ?? null, message.latencyMs ?? null, message.finishReason ?? null,
        message.requestId ?? null, now,
        costUsd, inputRate, outputRate, rateSource,
        message.promptLabel ?? null
      );
      touchConversationStatement.run(now, conversationId);
      return database.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    },
    deleteConversation(id) {
      return database.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
    },
    saveQualityScore(messageId, { accuracy, helpfulness, notes, judge }) {
      const now = new Date().toISOString();
      return database.prepare(`
        UPDATE messages SET quality_accuracy = ?, quality_helpfulness = ?, quality_notes = ?, quality_judge = ?, quality_scored_at = ?
        WHERE id = ? AND role = 'assistant'
      `).run(accuracy ?? null, helpfulness ?? null, notes ?? null, judge ?? null, now, messageId).changes > 0;
    },
    createEvalRun({ id, routerDeployment, baselineDeployment, judgeDeployment, config, datasetName, batchId, modeLabel }) {
      const startedAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO eval_runs (id, started_at, status, router_deployment, baseline_deployment, judge_deployment, config, dataset_name, batch_id, mode_label)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, startedAt, routerDeployment ?? null, baselineDeployment ?? null, judgeDeployment ?? null, config ?? null, datasetName ?? null, batchId ?? null, modeLabel ?? null);
      return id;
    },
    finishEvalRun(id, { status, runDir, dashboardPath, error, summaryJson }) {
      const completedAt = new Date().toISOString();
      database.prepare(`
        UPDATE eval_runs SET status = ?, completed_at = ?, run_dir = ?, dashboard_path = ?, error = ?, summary_json = ?
        WHERE id = ?
      `).run(status, completedAt, runDir ?? null, dashboardPath ?? null, error ?? null, summaryJson ?? null, id);
    },
    listEvalRuns(limit = 20) {
      return database.prepare(`SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
    },
    listEvalBatch(batchId) {
      return database.prepare(`SELECT * FROM eval_runs WHERE batch_id = ? ORDER BY started_at`).all(batchId);
    },
    createBenchmarkRun({ id, datasetName, endpoints, conversationIds, totalPrompts, totalCalls }) {
      const startedAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO benchmark_runs (id, started_at, status, dataset_name, endpoints_json, conversation_ids_json, total_prompts, total_calls)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        id, startedAt, datasetName ?? null,
        JSON.stringify(endpoints || []),
        JSON.stringify(conversationIds || []),
        totalPrompts ?? null, totalCalls ?? null
      );
      return id;
    },
    finishBenchmarkRun(id, { status, conversationIds, error }) {
      const completedAt = new Date().toISOString();
      database.prepare(`
        UPDATE benchmark_runs SET status = ?, completed_at = ?, conversation_ids_json = COALESCE(?, conversation_ids_json), error = ?
        WHERE id = ?
      `).run(status, completedAt, conversationIds ? JSON.stringify(conversationIds) : null, error ?? null, id);
    },
    listBenchmarkRuns(limit = 20) {
      return database.prepare(`SELECT * FROM benchmark_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
    },
    createEvalConversation({ title, prompts, results, difficultyByPromptId = {}, evalRunId }) {
      const now = new Date().toISOString();
      const conversationId = randomUUID();
      insertConversationStatement.run(conversationId, title.slice(0, 80), now, now);
      const insertMsg = database.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, complexity_level, routed_model, provider,
          prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, cached_tokens, latency_ms,
          finish_reason, request_id, created_at, cost_usd, input_rate_usd_per_million, output_rate_usd_per_million, rate_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = database.transaction(() => {
        for (let i = 0; i < prompts.length; i++) {
          const prompt = prompts[i];
          const result = results[i];
          if (!result) continue;
          const complexity = difficultyToLevel(difficultyByPromptId[prompt.id]) ?? null;
          const userTs = new Date(Date.parse(now) + i * 2).toISOString();
          const asstTs = new Date(Date.parse(now) + i * 2 + 1).toISOString();
          insertMsg.run(randomUUID(), conversationId, 'user', prompt.text, complexity, null, 'eval-toolkit',
            null, null, null, null, null, null, null, null, userTs, null, null, null, null);
          const model = result.model || 'unknown';
          const price = priceFor(model);
          const inTok = result.promptTokens ?? 0;
          const outTok = result.completionTokens ?? 0;
          const cost = (inTok * price.input + outTok * price.output) / 1_000_000;
          insertMsg.run(
            randomUUID(), conversationId, 'assistant', result.content || '', complexity, model, 'eval-toolkit',
            inTok, outTok, result.totalTokens ?? (inTok + outTok), null, null,
            result.latencyMs ?? null, result.status === 'success' ? 'stop' : (result.status || 'error'),
            result.requestId ?? null, asstTs,
            cost, price.input, price.output, 'eval-toolkit'
          );
        }
      });
      tx();
      touchConversationStatement.run(now, conversationId);
      if (evalRunId) database.prepare(`UPDATE eval_runs SET summary_json = COALESCE(summary_json, '{}') WHERE id = ?`).run(evalRunId);
      return conversationId;
    },
    clearAll() {
      database.prepare('DELETE FROM conversations').run();
    },
    getAnalytics(conversationId) {
      // Successful responses only — errored rows have no tokens/model. Failed rows tracked separately via failedRow / failedByLevel.
      const where = `role = 'assistant' AND (finish_reason IS NULL OR finish_reason != 'error')${conversationId ? ' AND conversation_id = @conversationId' : ''}`;
      const errorWhere = `role = 'assistant' AND finish_reason = 'error'${conversationId ? ' AND conversation_id = @conversationId' : ''}`;
      const params = conversationId ? { conversationId } : {};
      const summaryRow = database.prepare(`
        SELECT COUNT(*) AS responses, COUNT(DISTINCT routed_model) AS models,
          COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms
        FROM messages WHERE ${where}
      `).get(params);
      const failedRow = database.prepare(`SELECT COUNT(*) AS failed FROM messages WHERE ${errorWhere}`).get(params);
      const failedByLevel = database.prepare(`
        SELECT complexity_level AS level, COUNT(*) AS failed, GROUP_CONCAT(SUBSTR(content, 1, 200), ' | ') AS error_samples
        FROM messages WHERE ${errorWhere} AND complexity_level IS NOT NULL
        GROUP BY complexity_level
      `).all(params);
      const modelRows = database.prepare(`
        SELECT routed_model AS model, COUNT(*) AS responses,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(SUM(cost_usd), 0) AS stored_cost,
          COUNT(cost_usd) AS priced_rows,
          ROUND(AVG(latency_ms)) AS avg_latency_ms
        FROM messages WHERE ${where} GROUP BY routed_model ORDER BY responses DESC
      `).all(params);
      const complexityRows = database.prepare(`
        SELECT complexity_level AS level, routed_model AS model, COUNT(*) AS responses,
          ROUND(AVG(total_tokens)) AS avg_tokens, ROUND(AVG(latency_ms)) AS avg_latency_ms,
          ROUND(AVG(quality_accuracy), 2) AS avg_accuracy,
          ROUND(AVG(quality_helpfulness), 2) AS avg_helpfulness,
          ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY complexity_level), 1) AS share_pct
        FROM messages WHERE ${where} AND complexity_level IS NOT NULL
        GROUP BY complexity_level, routed_model ORDER BY complexity_level, responses DESC
      `).all(params);

      let actualCost = 0;
      let baselineCost = 0;
      const models = modelRows.map((row) => {
        // Prefer stored per-request cost (locked in at call time); fall back to current-rate compute for rows written before the migration.
        const stored = Number(row.stored_cost) || 0;
        const priced = Number(row.priced_rows) || 0;
        const unpricedRows = row.responses - priced;
        const fallback = unpricedRows > 0 ? calculateCost(row.model, row.prompt_tokens * (unpricedRows / row.responses), row.completion_tokens * (unpricedRows / row.responses)) : 0;
        const cost = stored + fallback;
        const baseline = calculateCost(BASELINE_MODEL, row.prompt_tokens, row.completion_tokens);
        actualCost += cost;
        baselineCost += baseline;
        return { ...row, tier: tierFor(row.model), cost, baseline_cost: baseline };
      });
      const savings = baselineCost - actualCost;
      const savingsPct = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

      return {
        summary: {
          ...summaryRow,
          failed: Number(failedRow?.failed) || 0,
          actual_cost: actualCost,
          baseline_cost: baselineCost,
          savings,
          savings_pct: savingsPct,
          baseline_model: BASELINE_MODEL
        },
        models,
        complexity: complexityRows.map((row) => ({ ...row, tier: tierFor(row.model) })),
        failedByLevel: failedByLevel.map((r) => ({ level: r.level, failed: Number(r.failed) || 0, error_samples: r.error_samples || '' }))
      };
    }
  };
}