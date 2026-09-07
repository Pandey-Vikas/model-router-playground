import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const azCommand = process.platform === 'win32' ? 'az.cmd' : 'az';
const useShell = process.platform === 'win32';

async function az(args, { timeoutMs = 300_000 } = {}) {
  const { stdout } = await execFileAsync(azCommand, [...args, '--only-show-errors', '--output', 'json'], {
    shell: useShell,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLKIT_DIR = join(rootDir, 'eval-toolkit');
export const DATASETS_DIR = join(rootDir, 'data', 'eval-datasets');
export const RESULTS_DIR = join(rootDir, 'data', 'eval-results');
const TOOLKIT_REPO = 'https://github.com/microsoft-foundry/Model-Router-Auto-Evaluation.git';

let activeProc = null;
let stopRequested = false;
let batchInProgress = false;
const listeners = new Set();

function emit(line) {
  const record = { ts: new Date().toISOString(), line };
  for (const listener of listeners) {
    try { listener(record); } catch { /* ignore */ }
  }
}

export function emitError(prefix, error) {
  emit(`${prefix}: ${error?.message || error}`);
  console.error(prefix, error);
}

export function subscribeEval(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function isBusy() {
  return activeProc !== null || batchInProgress;
}

export function stopEvaluation() {
  if (!activeProc && !batchInProgress) return { stopped: false, reason: 'No eval is currently running.' };
  stopRequested = true;
  const proc = activeProc;
  // Clear immediately so the user can start another run without hitting the busy check while taskkill/SIGTERM propagates.
  activeProc = null;
  if (proc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        proc.kill('SIGTERM');
      }
    } catch (error) {
      return { stopped: false, reason: error.message };
    }
  }
  emit('Evaluation stopped by user — batch will abort before next mode.');
  return { stopped: true };
}

export function getStatus() {
  const toolkitInstalled = existsSync(join(TOOLKIT_DIR, 'scripts', 'run_eval.py'));
  const venvPath = process.platform === 'win32'
    ? join(TOOLKIT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TOOLKIT_DIR, '.venv', 'bin', 'python');
  const venvReady = existsSync(venvPath);
  const envConfigured = existsSync(join(TOOLKIT_DIR, '.env'));
  const apiKeyPresent = !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_API_KEY.length > 4);
  return { toolkitInstalled, venvReady, envConfigured, apiKeyPresent, busy: isBusy() };
}

function runStreamed(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (activeProc) return reject(new Error('Another eval command is already running.'));
    emit(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd: options.cwd || rootDir, shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, ...(options.env || {}) } });
    activeProc = child;
    child.stdout.on('data', (buf) => String(buf).split(/\r?\n/).forEach((l) => { if (l) emit(l); }));
    child.stderr.on('data', (buf) => String(buf).split(/\r?\n/).forEach((l) => { if (l) emit(l); }));
    child.on('error', (err) => { activeProc = null; emit(`ERROR: ${err.message}`); reject(err); });
    child.on('exit', (code) => {
      activeProc = null;
      emit(`exit code ${code}`);
      if (code === 0) resolve(code);
      else reject(new Error(`Command exited with code ${code}`));
    });
  });
}

export async function installToolkit() {
  if (!existsSync(TOOLKIT_DIR)) {
    await runStreamed('git', ['clone', TOOLKIT_REPO, TOOLKIT_DIR]);
  } else {
    emit('Toolkit already cloned; pulling latest.');
    await runStreamed('git', ['pull'], { cwd: TOOLKIT_DIR });
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  await runStreamed(py, ['-m', 'venv', '.venv'], { cwd: TOOLKIT_DIR });
  const venvPy = process.platform === 'win32'
    ? join(TOOLKIT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TOOLKIT_DIR, '.venv', 'bin', 'python');
  await runStreamed(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: TOOLKIT_DIR });
  await runStreamed(venvPy, ['-m', 'pip', 'install', '-e', '.'], { cwd: TOOLKIT_DIR });
  patchClientForEntra();
  patchDashboardLabels();
  emit('Toolkit ready with Entra ID fallback patched in.');
}

function patchDashboardLabels() {
  const dashboardPath = join(TOOLKIT_DIR, 'src', 'dashboard.py');
  const oldSub = '<div class="subtitle">{_esc(eval_name)} &mdash; {rm.total_requests} prompts &mdash; Model Router vs {_esc(baseline_label)}</div>';
  const newSub = '<div class="subtitle">{rm.total_requests} prompts &middot; <b>Router deployment</b> (picks a model per prompt) <b>vs</b> <b>Fixed baseline</b> &ldquo;{_esc(baseline_label)}&rdquo;</div>';
  if (existsSync(dashboardPath)) {
    let src = readFileSync(dashboardPath, 'utf8');
    let changed = false;
    if (src.includes(oldSub)) { src = src.replace(oldSub, newSub); changed = true; }
    const explainerAnchor = '  <!-- KPI Cards -->';
    const explainer = `  <!-- How to read -->
  <details class="explainer" open>
    <summary>How to read this dashboard</summary>
    <p><b>What am I looking at?</b> The same prompts were sent to two places: your <b>router deployment</b> (which picks a cheap or premium model per prompt automatically) and one <b>fixed baseline</b> model. Metrics below compare the two.</p>
    <ul>
      <li><b>Cost Savings</b> &mdash; total dollars the router saved vs sending every prompt to the baseline. Positive = router is cheaper. Negative = baseline is cheaper.</li>
      <li><b>Latency (Mean / P50 / P90)</b> &mdash; how long a response took, in milliseconds. Mean is the average. <b>P50</b> is the median (half of requests were faster). <b>P90</b> is the slow tail (10% were slower). Lower is better.</li>
      <li><b>Router / Baseline Reliability</b> &mdash; how many calls succeeded out of the total. 100% means no timeouts or errors.</li>
      <li><b>Quality Win Rate</b> &mdash; percentage of prompts where an LLM judge said the router's answer was better than the baseline's.</li>
      <li><b>Avg Quality Score</b> &mdash; independent 1&ndash;5 scoring across accuracy, completeness, clarity, and helpfulness.</li>
      <li><b>Model Distribution</b> (chart below) &mdash; which underlying model the router chose for each prompt. Cheap models on easy prompts, premium models on hard prompts is the ideal pattern.</li>
    </ul>
    <p><b>What is "good"?</b> A healthy router run typically shows <b>≥30% cost savings</b> with a <b>quality win rate near 50%</b> (statistical tie with the baseline). If quality is much lower, your router is under-serving hard prompts. If cost savings are near zero, the router is routing everything to the premium model.</p>
  </details>
`;
    if (!src.includes('<details class="explainer"') && src.includes(explainerAnchor)) {
      src = src.replace(explainerAnchor, explainer + explainerAnchor);
      changed = true;
    }
    if (!src.includes('.explainer {')) {
      const cssMarker = '  .footer {{';
      const explainerCss = `  .explainer {{
    background: var(--white, #fff);
    border: 1px solid var(--gray-200, #e5e7eb);
    border-radius: 8px;
    padding: 14px 18px;
    margin: 0 0 18px 0;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  }}
  .explainer summary {{
    cursor: pointer;
    font-weight: 600;
    color: var(--gray-800, #1f2937);
    font-size: 0.95rem;
  }}
  .explainer[open] summary {{ margin-bottom: 8px; }}
  .explainer p, .explainer li {{ font-size: 0.85rem; color: var(--gray-700, #374151); line-height: 1.55; }}
  .explainer ul {{ margin: 6px 0 6px 20px; padding: 0; }}
  .kpi-card {{ position: relative; }}
  .kpi-card .label[title] {{ cursor: help; border-bottom: 1px dotted var(--gray-400, #9ca3af); }}
`;
      if (src.includes(cssMarker)) { src = src.replace(cssMarker, explainerCss + cssMarker); changed = true; }
    }
    src = src.replace('<div class="label">Cost Savings</div>', '<div class="label" title="Total $ saved by the router vs sending every prompt to the baseline. Positive = router cheaper.">Cost Savings</div>');
    src = src.replace('<div class="label">Latency (Mean)</div>', '<div class="label" title="Average response time in milliseconds. Lower is better.">Latency (Mean)</div>');
    src = src.replace('<div class="label">Latency P50</div>', '<div class="label" title="Median: half of requests were faster than this.">Latency P50</div>');
    src = src.replace('<div class="label">Latency P90</div>', '<div class="label" title="90th percentile: only 10% of requests were slower.">Latency P90</div>');
    src = src.replace('<div class="label">Router Reliability</div>', '<div class="label" title="Successful router calls / total calls.">Router Reliability</div>');
    src = src.replace('<div class="label">Baseline Reliability</div>', '<div class="label" title="Successful baseline calls / total calls.">Baseline Reliability</div>');
    src = src.replace('<div class="label">Quality Win Rate</div>', '<div class="label" title="Percentage of prompts where an LLM judge said the router\\\'s answer was better.">Quality Win Rate</div>');
    src = src.replace('<div class="label">Avg Quality Score</div>', '<div class="label" title="Judge score 1-5 across accuracy, completeness, clarity, helpfulness.">Avg Quality Score</div>');
    if (src !== readFileSync(dashboardPath, 'utf8') || changed) {
      writeFileSync(dashboardPath, src, 'utf8');
      emit('Patched dashboard: subtitle + explainer + tooltips.');
    }
  }
  const reportPath = join(TOOLKIT_DIR, 'src', 'report.py');
  const oldExec = 'f"Model Router was evaluated against **{config.baseline.deployment_name}** "';
  const newExec = 'f"Router deployment (which picks a model per prompt) was compared against the fixed baseline **{config.baseline.deployment_name}** "';
  if (existsSync(reportPath)) {
    const src = readFileSync(reportPath, 'utf8');
    if (src.includes(oldExec)) { writeFileSync(reportPath, src.split(oldExec).join(newExec), 'utf8'); emit('Patched report exec summary.'); }
  }
  patchJudgeSpeedups();
}

function patchJudgeSpeedups() {
  const configPath = join(TOOLKIT_DIR, 'configs', 'default.yaml');
  if (existsSync(configPath)) {
    const src = readFileSync(configPath, 'utf8');
    const patched = src.replace(/(\n\s{2}max_parallel:\s*)3(\s*\n)/, '$18$2');
    if (patched !== src) { writeFileSync(configPath, patched, 'utf8'); emit('Judge parallel bumped 3 → 8 in default.yaml.'); }
  }
  const judgePath = join(TOOLKIT_DIR, 'src', 'judge.py');
  if (existsSync(judgePath)) {
    const src = readFileSync(judgePath, 'utf8');
    const patched = src.replace('"max_completion_tokens": 1024,', '"max_completion_tokens": 256,');
    if (patched !== src) { writeFileSync(judgePath, patched, 'utf8'); emit('Judge max_completion_tokens capped 1024 → 256 in judge.py.'); }
  }
}

function patchClientForEntra() {
  const clientPath = join(TOOLKIT_DIR, 'src', 'client.py');
  if (!existsSync(clientPath)) { emit('WARNING: src/client.py not found — cannot patch for Entra.'); return; }
  let source = readFileSync(clientPath, 'utf8');
  if (source.includes('_entra_token_provider')) { emit('Client already patched for Entra ID.'); return; }
  const helper = `
import subprocess as _subprocess


def _entra_token_provider():
    """RouteLab patch: fall back to Entra ID via az CLI when api_key is empty."""
    result = _subprocess.run(
        ['az', 'account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--query', 'accessToken', '-o', 'tsv'],
        capture_output=True, text=True, shell=True
    )
    token = result.stdout.strip()
    if not token:
        raise RuntimeError(f"Could not acquire Entra token via az CLI: {result.stderr}")
    return token

`;
  const marker = 'def _build_client(endpoint_config: EndpointConfig)';
  const patchedFn = `def _build_client(endpoint_config: EndpointConfig) -> AsyncAzureOpenAI | AsyncOpenAI:
    """Build an async OpenAI client from endpoint configuration."""
    if endpoint_config.type == "azure_openai":
        if endpoint_config.api_key:
            return AsyncAzureOpenAI(
                azure_endpoint=endpoint_config.endpoint_url,
                api_key=endpoint_config.api_key,
                api_version="2024-12-01-preview",
            )
        return AsyncAzureOpenAI(
            azure_endpoint=endpoint_config.endpoint_url,
            azure_ad_token_provider=_entra_token_provider,
            api_version="2024-12-01-preview",
        )
    elif endpoint_config.type == "openai_compatible":
        return AsyncOpenAI(
            base_url=endpoint_config.endpoint_url,
            api_key=endpoint_config.api_key,
        )
    else:
        raise ValueError(
            f"Unknown endpoint type: '{endpoint_config.type}'. "
            f"Supported: 'azure_openai', 'openai_compatible'"
        )`;
  const before = source.substring(0, source.indexOf(marker));
  const after = source.substring(source.indexOf(marker));
  const originalEnd = after.indexOf('\nclass ');
  if (originalEnd === -1) { emit('WARNING: could not locate function end in client.py — patch skipped.'); return; }
  const rest = after.substring(originalEnd);
  const patched = before + helper + patchedFn + rest;
  writeFileSync(clientPath, patched, 'utf8');
  emit('Patched src/client.py: empty api_key now falls back to Entra ID (az account get-access-token).');
}

export function configureToolkitEnv({ routerEndpoint, routerDeployment, apiKey, apiVersion, baselineEndpoint, baselineDeployment, baselineKey, judgeEndpoint, judgeDeployment, judgeKey }) {
  if (!existsSync(TOOLKIT_DIR)) throw new Error('Toolkit not installed yet.');
  const openaiEndpoint = routerEndpoint || process.env.AZURE_OPENAI_ENDPOINT || '';
  const inferenceEndpoint = openaiEndpoint.replace(/\/+$/, '');
  const effectiveKey = apiKey || process.env.AZURE_OPENAI_API_KEY || '';
  if (!effectiveKey) {
    emit('No API key found — the toolkit will use Entra ID (via patched client) using your az CLI session.');
  }
  const lines = [
    '# Written automatically by RouteLab playground',
    '# Azure Model Router (routed via openai.azure.com)',
    `AZURE_MODEL_ROUTER_ENDPOINT=${inferenceEndpoint}`,
    `AZURE_MODEL_ROUTER_KEY=${effectiveKey}`,
    `AZURE_MODEL_ROUTER_DEPLOYMENT=${routerDeployment || ''}`,
    '',
    '# Azure OpenAI baseline (uses openai.azure.com endpoint)',
    `AZURE_OPENAI_ENDPOINT=${openaiEndpoint}`,
    `AZURE_OPENAI_KEY=${baselineKey || effectiveKey}`,
    `AZURE_BASELINE_DEPLOYMENT=${baselineDeployment || ''}`,
    '',
    '# Judge model',
    `AZURE_JUDGE_ENDPOINT=${judgeEndpoint || openaiEndpoint}`,
    `AZURE_JUDGE_KEY=${judgeKey || effectiveKey}`,
    `AZURE_JUDGE_DEPLOYMENT=${judgeDeployment || baselineDeployment || ''}`
  ];
  writeFileSync(join(TOOLKIT_DIR, '.env'), lines.join('\n') + '\n', 'utf8');
  emit('Wrote toolkit .env with correct variable names.');
}

function countPrompts(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (filePath.toLowerCase().endsWith('.csv')) {
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      return Math.max(0, lines.length - 1);
    }
    let n = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).prompt) n++; } catch { /* skip malformed */ }
    }
    return n;
  } catch { return null; }
}

export function listToolkitDatasets() {
  const dir = join(TOOLKIT_DIR, 'datasets');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => /\.(jsonl|csv)$/i.test(n))
      .map((name) => {
        const path = join(dir, name);
        return { name, path, source: 'toolkit', promptCount: countPrompts(path) };
      });
  } catch { return []; }
}

export function listUserDatasets() {
  if (!existsSync(DATASETS_DIR)) return [];
  try {
    return readdirSync(DATASETS_DIR)
      .filter((n) => /\.(jsonl|csv)$/i.test(n))
      .filter((n) => n !== 'prompts-scenarios30.jsonl' && n !== 'prompts-quick15.jsonl' && n !== 'prompts-demo10.jsonl')
      .map((name) => {
        const path = join(DATASETS_DIR, name);
        return { name, path, source: 'user', promptCount: countPrompts(path) };
      });
  } catch { return []; }
}

export function resolveDatasetForDownload(name) {
  const safe = basename(String(name || ''));
  if (!safe || !/\.(jsonl|csv|md)$/i.test(safe)) throw new Error('Invalid dataset name');
  const candidates = [
    join(TOOLKIT_DIR, 'datasets', safe),
    join(DATASETS_DIR, safe)
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error('Dataset not found');
}

export function saveDataset(name, content) {
  mkdirSync(DATASETS_DIR, { recursive: true });
  const safe = basename(String(name || 'prompts.jsonl'));
  if (!/\.(jsonl|csv)$/i.test(safe)) throw new Error('Dataset filename must end in .jsonl or .csv');
  const path = join(DATASETS_DIR, safe);
  writeFileSync(path, content, 'utf8');
  emit(`Dataset saved: ${path}`);
  return path;
}

export async function runEvaluation({ datasetPath, config = 'configs/quick_test.yaml', dryRun = false, runName = null, db, routerDeployment, baselineDeployment, judgeDeployment, batchId = null, modeLabel = null }) {
  if (!existsSync(TOOLKIT_DIR)) throw new Error('Toolkit not installed yet.');
  const venvPy = process.platform === 'win32'
    ? join(TOOLKIT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TOOLKIT_DIR, '.venv', 'bin', 'python');
  const args = ['scripts/run_eval.py', '--config', config, '--dataset', datasetPath];
  if (dryRun) args.push('--dry-run');
  if (runName) args.push('--run-name', runName);
  const runId = randomUUID();
  if (db && !dryRun) {
    db.createEvalRun({ id: runId, routerDeployment, baselineDeployment, judgeDeployment, config, datasetName: basename(datasetPath), batchId, modeLabel });
  }
  try {
    await runStreamed(venvPy, args, { cwd: TOOLKIT_DIR });
    if (db && !dryRun) {
      const dashboard = findLatestReport();
      const runDir = dashboard ? dirname(dashboard) : null;
      let summaryJson = null;
      if (runDir) {
        const summary = parseToolkitReport(runDir);
        if (summary) summaryJson = JSON.stringify(summary);
      }
      db.finishEvalRun(runId, { status: 'success', runDir, dashboardPath: dashboard, summaryJson });
      if (runDir) {
        try {
          materializeRunAsConversations({ db, runDir, datasetPath, runId, routerDeployment, baselineDeployment, modeLabel });
        } catch (matError) {
          emit(`WARN: could not materialize eval as conversations: ${matError.message}`);
        }
      }
    }
    return runId;
  } catch (error) {
    if (db && !dryRun) db.finishEvalRun(runId, { status: 'failed', error: error.message });
    throw error;
  }
}

function materializeRunAsConversations({ db, runDir, datasetPath, runId, routerDeployment, baselineDeployment, modeLabel }) {
  const rawPath = join(runDir, 'raw_results.jsonl');
  if (!existsSync(rawPath) || !existsSync(datasetPath)) return;
  const prompts = new Map();
  const difficulty = {};
  for (const line of readFileSync(datasetPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id) {
        prompts.set(obj.id, obj.prompt || '');
        if (obj.difficulty) difficulty[obj.id] = obj.difficulty;
      }
    } catch { /* ignore */ }
  }
  const router = [];
  const baseline = [];
  for (const line of readFileSync(rawPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const target = r.endpoint === 'model_router' ? router : r.endpoint === 'baseline' ? baseline : null;
      if (!target) continue;
      target.push({
        promptId: r.prompt_id,
        content: r.response_text || '',
        model: (r.model_name || '').replace(/-\d{4}-\d{2}-\d{2}$/, ''),
        promptTokens: r.prompt_tokens || 0,
        completionTokens: r.completion_tokens || 0,
        totalTokens: r.total_tokens || 0,
        latencyMs: Math.round(r.latency_ms || 0),
        status: r.status || 'success',
        requestId: r.request_id || null
      });
    } catch { /* ignore */ }
  }
  const orderedPromptIds = [...prompts.keys()];
  const buildOrdered = (results) => orderedPromptIds.map((id) => results.find((r) => r.promptId === id) || null);
  const shortRunId = runId.slice(0, 8);
  const modeTag = modeLabel ? `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} · ` : '';
  const evalTag = `[Eval ${shortRunId}]`;
  if (router.length) {
    db.createEvalConversation({
      title: `${evalTag} ${modeTag}Router · ${routerDeployment || 'router'}`,
      prompts: orderedPromptIds.map((id) => ({ id, text: prompts.get(id) })),
      results: buildOrdered(router),
      difficultyByPromptId: difficulty,
      evalRunId: runId
    });
    emit(`Materialized ${router.length} router responses as conversation.`);
  }
  if (baseline.length) {
    db.createEvalConversation({
      title: `${evalTag} ${modeTag}Baseline · ${baselineDeployment || 'baseline'}`,
      prompts: orderedPromptIds.map((id) => ({ id, text: prompts.get(id) })),
      results: buildOrdered(baseline),
      difficultyByPromptId: difficulty,
      evalRunId: runId
    });
    emit(`Materialized ${baseline.length} baseline responses as conversation.`);
  }
}

export function materializeExistingEvalRun({ db, runRow, datasetOverride }) {
  if (!runRow) throw new Error('Eval run not found.');
  const runDir = runRow.run_dir;
  if (!runDir || !existsSync(runDir)) throw new Error('Run directory missing on disk; cannot materialize.');
  const datasetName = runRow.dataset_name;
  let datasetPath = datasetOverride;
  if (!datasetPath && datasetName) {
    const candidates = [
      join(TOOLKIT_DIR, 'datasets', datasetName),
      join(DATASETS_DIR, datasetName)
    ];
    datasetPath = candidates.find((p) => existsSync(p));
  }
  if (!datasetPath) throw new Error(`Dataset "${datasetName}" not found in toolkit or user dir.`);
  materializeRunAsConversations({
    db, runDir, datasetPath,
    runId: runRow.id,
    routerDeployment: runRow.router_deployment,
    baselineDeployment: runRow.baseline_deployment,
    modeLabel: runRow.mode_label
  });
  return { ok: true };
}

export async function runThreeModeEvaluation({ datasetPath, config, db, modes, baselineDeployment, judgeDeployment }) {
  const batchId = randomUUID();
  batchInProgress = true;
  stopRequested = false;
  emit(`===== 3-MODE COMPARISON started (batch ${batchId.slice(0, 8)}) =====`);
  try {
    for (const [label, deployment] of modes) {
      if (stopRequested) { emit(`Batch aborted before mode "${label}" — stop was requested.`); break; }
      if (!deployment) { emit(`[skip] ${label}: no deployment configured`); continue; }
      emit(`----- Running mode: ${label} (deployment=${deployment}) -----`);
      configureToolkitEnv({ routerDeployment: deployment, baselineDeployment, judgeDeployment });
      try {
        await runEvaluation({
          datasetPath, config, db,
          routerDeployment: deployment,
          baselineDeployment,
          judgeDeployment,
          batchId,
          modeLabel: label
        });
      } catch (error) {
        if (stopRequested) { emit(`Mode ${label} killed by stop request.`); break; }
        emit(`Mode ${label} failed: ${error.message}. Continuing with next mode.`);
      }
    }
    if (stopRequested) emit(`===== 3-MODE COMPARISON stopped (batch ${batchId.slice(0, 8)}) =====`);
    else emit(`===== 3-MODE COMPARISON complete (batch ${batchId.slice(0, 8)}) =====`);
  } finally {
    batchInProgress = false;
    stopRequested = false;
  }
  return batchId;
}

function parseToolkitReport(runDir) {
  const reportPath = join(runDir, 'report.md');
  if (!existsSync(reportPath)) return null;
  try {
    const md = readFileSync(reportPath, 'utf8');
    const summary = {};
    const promptMatch = md.match(/on \*\*(\d+) prompts?\*\*/);
    if (promptMatch) summary.prompts = Number(promptMatch[1]);
    const baselineMatch = md.match(/against \*\*([^*]+)\*\*/);
    if (baselineMatch) summary.baseline = baselineMatch[1];
    const rows = {};
    for (const line of md.split('\n')) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
      if (!m) continue;
      const key = m[1].trim();
      if (key === 'Metric' || key.startsWith('---')) continue;
      rows[key] = { router: m[2].trim(), baseline: m[3].trim() };
    }
    if (rows['Successful']) {
      summary.routerSuccess = Number(rows['Successful'].router) || 0;
      summary.baselineSuccess = Number(rows['Successful'].baseline) || 0;
    }
    if (rows['Errors']) {
      summary.routerErrors = Number(rows['Errors'].router) || 0;
      summary.baselineErrors = Number(rows['Errors'].baseline) || 0;
    }
    if (rows['Total requests']) summary.total = Number(rows['Total requests'].router) || 0;
    if (rows['Mean']) { summary.routerLatencyMean = rows['Mean'].router; summary.baselineLatencyMean = rows['Mean'].baseline; }
    if (rows['p95']) { summary.routerLatencyP95 = rows['p95'].router; summary.baselineLatencyP95 = rows['p95'].baseline; }
    if (rows['Total cost']) { summary.routerCost = rows['Total cost'].router; summary.baselineCost = rows['Total cost'].baseline; }
    if (rows['Avg cost/request']) { summary.routerCostAvg = rows['Avg cost/request'].router; summary.baselineCostAvg = rows['Avg cost/request'].baseline; }
    return summary;
  } catch { return null; }
}

export function findLatestReport() {
  const resultsDir = join(TOOLKIT_DIR, 'results');
  if (!existsSync(resultsDir)) return null;
  try {
    const entries = readdirSync(resultsDir).map((n) => ({ name: n, mtime: statSync(join(resultsDir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (!entries.length) return null;
    const dashboard = join(resultsDir, entries[0].name, 'dashboard.html');
    return existsSync(dashboard) ? dashboard : null;
  } catch { return null; }
}

export function openReport() {
  const report = findLatestReport();
  if (!report) throw new Error('No report available yet.');
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', report], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [report], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [report], { detached: true, stdio: 'ignore' }).unref();
  }
  return report;
}

function deriveAccountName() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const match = endpoint.match(/https:\/\/([^.]+)\./);
  if (!match) throw new Error('Could not derive Foundry account name from AZURE_OPENAI_ENDPOINT.');
  return match[1];
}

async function findResourceGroup(accountName) {
  const list = await az(['cognitiveservices', 'account', 'list']);
  const match = (list || []).find((a) => a.name === accountName);
  if (!match) throw new Error(`Foundry account "${accountName}" not found in current subscription.`);
  return match.id.split('/')[4];
}

export async function listAccountDeployments() {
  const account = deriveAccountName();
  const rg = await findResourceGroup(account);
  const deps = await az(['cognitiveservices', 'account', 'deployment', 'list', '--name', account, '--resource-group', rg]);
  return (deps || []).map((d) => ({
    name: d.name,
    model: d.properties?.model?.name,
    version: d.properties?.model?.version,
    sku: d.sku?.name,
    capacity: d.sku?.capacity,
    state: d.properties?.provisioningState
  }));
}

export const RECOMMENDED_MODELS = [
  { role: 'baseline', deploymentName: 'gpt-5.2', modelName: 'gpt-5.2', modelVersion: '2025-12-11', sku: 'GlobalStandard', capacity: 1, note: 'Strong OpenAI model — good baseline vs router.' },
  { role: 'judge', deploymentName: 'gpt-5.6-luna', modelName: 'gpt-5.6-luna', modelVersion: '2026-07-09', sku: 'GlobalStandard', capacity: 1, note: 'Latest frontier — high-quality LLM-as-judge.' },
  { role: 'judge', deploymentName: 'claude-sonnet-4-5', modelName: 'claude-sonnet-4-5', modelVersion: '20250929', sku: 'GlobalStandard', capacity: 1, note: 'Anthropic judge (requires access to Claude models).' }
];

export async function deployModel({ deploymentName, modelName, modelVersion, sku = 'GlobalStandard', capacity = 1 }) {
  if (!deploymentName || !modelName || !modelVersion) throw new Error('deploymentName, modelName and modelVersion are required.');
  const account = deriveAccountName();
  const rg = await findResourceGroup(account);
  emit(`Deploying ${modelName} v${modelVersion} as "${deploymentName}" (${sku}, capacity ${capacity})…`);
  await runStreamed(azCommand, [
    'cognitiveservices', 'account', 'deployment', 'create',
    '--name', account,
    '--resource-group', rg,
    '--deployment-name', deploymentName,
    '--model-name', modelName,
    '--model-version', modelVersion,
    '--model-format', 'OpenAI',
    '--sku-name', sku,
    '--sku-capacity', String(capacity),
    '--only-show-errors',
    '--output', 'json'
  ]);
  emit(`Deployment "${deploymentName}" created.`);
}

export async function deployRouter({ deploymentName, mode = 'balanced', capacity = 20, version = '2025-11-18' }) {
  if (!deploymentName) throw new Error('deploymentName is required.');
  if (!['balanced', 'cost', 'quality'].includes(mode)) throw new Error(`mode must be balanced|cost|quality (got ${mode}).`);
  const account = deriveAccountName();
  emit(`Discovering resource group for Foundry account "${account}"…`);
  const list = await az(['cognitiveservices', 'account', 'list']);
  const match = (list || []).find((a) => a.name === account);
  if (!match) throw new Error(`Foundry account "${account}" not found in current subscription. Run "az login" or check AZURE_OPENAI_ENDPOINT.`);
  const parts = match.id.split('/');
  const subscriptionId = parts[2];
  const resourceGroup = parts[4];
  emit(`Getting management-plane token…`);
  const { stdout: tokenJson } = await execFileAsync(azCommand, ['account', 'get-access-token', '--resource', 'https://management.azure.com', '--only-show-errors', '--output', 'json'], { shell: useShell, maxBuffer: 8 * 1024 * 1024 });
  const token = JSON.parse(tokenJson).accessToken;
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${account}/deployments/${deploymentName}?api-version=2025-10-01-preview`;
  const body = {
    sku: { name: 'GlobalStandard', capacity: Number(capacity) || 20 },
    properties: {
      model: { format: 'OpenAI', name: 'model-router', version },
      routing: { mode }
    }
  };
  emit(`PUT ${url}`);
  emit(`Body: model-router v${version}, routing.mode=${mode}, capacity=${capacity}`);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    emit(`HTTP ${response.status} ${response.statusText}`);
    emit(text.slice(0, 800));
    throw new Error(`Router deployment failed: HTTP ${response.status}. ${text.slice(0, 200)}`);
  }
  emit(`HTTP ${response.status} — deployment accepted. Provisioning may take ~30 seconds.`);
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* async response might be empty */ }
  const provisioningState = parsed?.properties?.provisioningState;
  if (provisioningState) emit(`Provisioning state: ${provisioningState}`);
  emit(`Router "${deploymentName}" (${mode} mode) created successfully.`);
  return { deploymentName, mode, capacity, provisioningState };
}

export async function deployBatch({ items }) {
  if (!Array.isArray(items) || !items.length) throw new Error('No deployments requested.');
  const results = [];
  for (const item of items) {
    const key = item.key || item.deploymentName;
    emit(`===== BATCH: ${key} — starting =====`);
    // status:started event so UI can flip pill to "creating"
    emit(`__STATUS__ ${JSON.stringify({ key, state: 'creating' })}`);
    try {
      if (item.kind === 'router') {
        await deployRouter({ deploymentName: item.deploymentName, mode: item.mode, capacity: item.capacity, version: item.version });
      } else if (item.kind === 'model') {
        await deployModel({ deploymentName: item.deploymentName, modelName: item.modelName, modelVersion: item.modelVersion, sku: item.sku, capacity: item.capacity });
      } else {
        throw new Error(`Unknown deployment kind "${item.kind}"`);
      }
      emit(`__STATUS__ ${JSON.stringify({ key, state: 'success' })}`);
      results.push({ key, ok: true });
    } catch (error) {
      emit(`FAILED: ${error.message}`);
      emit(`__STATUS__ ${JSON.stringify({ key, state: 'failed', error: error.message })}`);
      results.push({ key, ok: false, error: error.message });
    }
    emit(`===== BATCH: ${key} — done =====`);
  }
  emit(`===== BATCH complete: ${results.filter((r) => r.ok).length}/${results.length} succeeded =====`);
  return results;
}
