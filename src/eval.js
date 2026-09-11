import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, sep as pathSep } from 'node:path';
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
const listeners = new Set();

function emit(line) {
  const record = { ts: new Date().toISOString(), line };
  for (const listener of listeners) {
    try { listener(record); } catch { /* ignore */ }
  }
}

export function subscribeEval(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function isBusy() {
  return activeProc !== null;
}

export function stopEvaluation() {
  if (!activeProc) return { stopped: false, reason: 'No eval is currently running.' };
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(activeProc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      activeProc.kill('SIGTERM');
    }
    emit('Evaluation stopped by user.');
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: error.message };
  }
}

export function getStatus() {
  const toolkitInstalled = existsSync(join(TOOLKIT_DIR, 'scripts', 'run_eval.py'));
  const venvPath = process.platform === 'win32'
    ? join(TOOLKIT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TOOLKIT_DIR, '.venv', 'bin', 'python');
  const venvReady = existsSync(venvPath);
  const envConfigured = existsSync(join(TOOLKIT_DIR, '.env'));
  const apiKeyPresent = !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_API_KEY.length > 4);
  return { toolkitInstalled, venvReady, envConfigured, apiKeyPresent, busy: activeProc !== null };
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
  emit('Toolkit ready with Entra ID fallback patched in.');
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

export function listToolkitDatasets() {
  const dir = join(TOOLKIT_DIR, 'datasets');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => /\.(jsonl|csv)$/i.test(n))
      .map((name) => {
        const path = join(dir, name);
        let count = null;
        try {
          const text = readFileSync(path, 'utf8');
          const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
          count = name.toLowerCase().endsWith('.csv') ? Math.max(0, lines - 1) : lines;
        } catch { /* leave null */ }
        return { name, path, count };
      });
  } catch { return []; }
}

export function listSampleDatasets() {
  const dir = join(rootDir, 'samples');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => /\.(jsonl|csv|json|txt)$/i.test(n))
      .map((name) => {
        const path = join(dir, name);
        let count = null;
        try {
          const text = readFileSync(path, 'utf8');
          const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
          count = name.toLowerCase().endsWith('.csv') ? Math.max(0, lines - 1) : lines;
        } catch { /* leave null */ }
        return { name, path, count };
      });
  } catch { return []; }
}

export function saveDataset(name, content) {
  mkdirSync(DATASETS_DIR, { recursive: true });
  const path = join(DATASETS_DIR, name);
  writeFileSync(path, content, 'utf8');
  emit(`Dataset saved: ${path}`);
  return path;
}

export function readDataset(requestedPath) {
  if (!requestedPath) throw new Error('path is required');
  const target = resolve(requestedPath);
  const allowedRoots = [
    resolve(join(TOOLKIT_DIR, 'datasets')),
    resolve(DATASETS_DIR),
    resolve(join(rootDir, 'samples'))
  ];
  const ok = allowedRoots.some((root) => target === root || target.startsWith(root + pathSep));
  if (!ok) throw new Error('Path not in an allowed dataset directory');
  if (!existsSync(target)) throw new Error('File not found');
  return { path: target, name: basename(target), content: readFileSync(target, 'utf8') };
}

export async function runEvaluation({ datasetPath, config = 'configs/quick_test.yaml', dryRun = false, runName = null, db, routerDeployment, baselineDeployment, judgeDeployment }) {
  if (!existsSync(TOOLKIT_DIR)) throw new Error('Toolkit not installed yet.');
  const venvPy = process.platform === 'win32'
    ? join(TOOLKIT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TOOLKIT_DIR, '.venv', 'bin', 'python');
  const args = ['scripts/run_eval.py', '--config', config, '--dataset', datasetPath];
  if (dryRun) args.push('--dry-run');
  if (runName) args.push('--run-name', runName);
  const runId = randomUUID();
  if (db && !dryRun) {
    db.createEvalRun({ id: runId, routerDeployment, baselineDeployment, judgeDeployment, config, datasetName: basename(datasetPath) });
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
    }
  } catch (error) {
    if (db && !dryRun) db.finishEvalRun(runId, { status: 'failed', error: error.message });
    throw error;
  }
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
