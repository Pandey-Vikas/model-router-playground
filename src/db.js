import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { calculateCost, tierFor, BASELINE_MODEL } from '../public/pricing.js';

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
  `);

  const existingCols = new Set(database.prepare("PRAGMA table_info(messages)").all().map((r) => r.name));
  const migrations = [
    ['quality_accuracy', 'INTEGER'],
    ['quality_helpfulness', 'INTEGER'],
    ['quality_notes', 'TEXT'],
    ['quality_judge', 'TEXT'],
    ['quality_scored_at', 'TEXT']
  ];
  for (const [col, type] of migrations) {
    if (!existingCols.has(col)) database.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
  }

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
      finish_reason, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const now = new Date().toISOString();
      const id = randomUUID();
      if (message.role === 'user') setInitialTitleStatement.run(message.content.slice(0, 80), conversationId);
      insertMessageStatement.run(
        id, conversationId, message.role, message.content, message.complexityLevel ?? null,
        message.routedModel ?? null, message.provider ?? null, message.promptTokens ?? null,
        message.completionTokens ?? null, message.totalTokens ?? null, message.reasoningTokens ?? null,
        message.cachedTokens ?? null, message.latencyMs ?? null, message.finishReason ?? null,
        message.requestId ?? null, now
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
    createEvalRun({ id, routerDeployment, baselineDeployment, judgeDeployment, config, datasetName }) {
      const startedAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO eval_runs (id, started_at, status, router_deployment, baseline_deployment, judge_deployment, config, dataset_name)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(id, startedAt, routerDeployment ?? null, baselineDeployment ?? null, judgeDeployment ?? null, config ?? null, datasetName ?? null);
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
    clearAll() {
      database.prepare('DELETE FROM conversations').run();
    },
    getAnalytics(conversationId) {
      const where = `role = 'assistant'${conversationId ? ' AND conversation_id = @conversationId' : ''}`;
      const params = conversationId ? { conversationId } : {};
      const summaryRow = database.prepare(`
        SELECT COUNT(*) AS responses, COUNT(DISTINCT routed_model) AS models,
          COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms
        FROM messages WHERE ${where}
      `).get(params);
      const modelRows = database.prepare(`
        SELECT routed_model AS model, COUNT(*) AS responses,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(total_tokens), 0) AS tokens,
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
        const cost = calculateCost(row.model, row.prompt_tokens, row.completion_tokens);
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
          actual_cost: actualCost,
          baseline_cost: baselineCost,
          savings,
          savings_pct: savingsPct,
          baseline_model: BASELINE_MODEL
        },
        models,
        complexity: complexityRows.map((row) => ({ ...row, tier: tierFor(row.model) }))
      };
    }
  };
}