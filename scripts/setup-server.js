import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');
const envPath = join(rootDir, '.env');
const htmlPath = join(scriptDir, 'setup.html');
const azCommand = process.platform === 'win32' ? 'az.cmd' : 'az';
const useShell = process.platform === 'win32';

async function az(args, { timeoutMs = 120_000 } = {}) {
  const { stdout } = await execFileAsync(azCommand, [...args, '--only-show-errors', '--output', 'json'], {
    shell: useShell,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

let activeLoginChild = null;
let loginState = { state: 'idle' };

function killActiveLogin() {
  if (!activeLoginChild) return;
  try { activeLoginChild.kill(); } catch { /* ignore */ }
  activeLoginChild = null;
}

function startBrowserLogin(tenantId) {
  killActiveLogin();
  loginState = { state: 'pending' };
  const args = ['login', '--only-show-errors'];
  if (tenantId) args.push('--tenant', tenantId);
  return new Promise((resolve, reject) => {
    const child = spawn(azCommand, args, { shell: useShell, windowsHide: true });
    activeLoginChild = child;
    let buffer = '';
    let urlReturned = false;
    const finishUrl = (url) => { if (!urlReturned) { urlReturned = true; resolve({ url }); } };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/login\.microsoftonline\.com\/[^\s"'<>]+/);
      if (match) finishUrl(match[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      activeLoginChild = null;
      loginState = { state: 'failed', error: err.message };
      if (!urlReturned) reject(err);
    });
    child.on('exit', (code) => {
      activeLoginChild = null;
      if (code === 0) {
        loginState = { state: 'success' };
        if (!urlReturned) finishUrl('');
      } else {
        const message = buffer.trim() || `az login exited with code ${code}`;
        loginState = { state: 'failed', error: message };
        if (!urlReturned) reject(new Error(message));
      }
    });
  });
}

function startDeviceCodeLogin(tenantId) {
  killActiveLogin();
  loginState = { state: 'pending' };
  const args = ['login', '--use-device-code', '--only-show-errors'];
  if (tenantId) args.push('--tenant', tenantId);
  return new Promise((resolve, reject) => {
    const child = spawn(azCommand, args, { shell: useShell, windowsHide: true });
    activeLoginChild = child;
    let buffer = '';
    let codeReturned = false;
    const finishCode = (value) => { if (!codeReturned) { codeReturned = true; resolve(value); } };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const codeMatch = buffer.match(/enter the code\s+([A-Z0-9-]{6,})\s+to authenticate/i);
      if (codeMatch) {
        const urlMatch = buffer.match(/https?:\/\/\S+devicelogin/i);
        finishCode({ code: codeMatch[1], url: urlMatch ? urlMatch[0] : 'https://microsoft.com/devicelogin' });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      activeLoginChild = null;
      loginState = { state: 'failed', error: err.message };
      if (!codeReturned) reject(err);
    });
    child.on('exit', (code) => {
      activeLoginChild = null;
      if (code === 0) {
        loginState = { state: 'success' };
      } else {
        const message = buffer.trim() || `az login exited with code ${code}`;
        loginState = { state: 'failed', error: message };
        if (!codeReturned) reject(new Error(message));
      }
    });
  });
}

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

function writeEnv(values) {
  const lines = [
    `MODEL_PROVIDER=${values.provider}`,
    `PORT=${values.port || 3000}`,
    'DATABASE_PATH=./data/router-playground.db',
    '',
    `AZURE_OPENAI_ENDPOINT=${values.endpoint}`,
    `MODEL_ROUTER_DEPLOYMENT_NAME=${values.deployment}`,
    `AZURE_OPENAI_API_VERSION=${values.apiVersion}`
  ];
  if (values.deploymentBalanced) lines.push(`MODEL_ROUTER_DEPLOYMENT_BALANCED=${values.deploymentBalanced}`);
  if (values.deploymentCost) lines.push(`MODEL_ROUTER_DEPLOYMENT_COST=${values.deploymentCost}`);
  if (values.deploymentQuality) lines.push(`MODEL_ROUTER_DEPLOYMENT_QUALITY=${values.deploymentQuality}`);
  if (values.apiKey) lines.push(`AZURE_OPENAI_API_KEY=${values.apiKey}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

let launchedChild = null;
let launchedPort = 3000;

function launchApp(port) {
  launchedPort = port;
  if (launchedChild) return;
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  launchedChild = spawn(process.execPath, [
    '--env-file-if-exists=.env',
    '--disable-warning=ExperimentalWarning',
    'src/server.js'
  ], { cwd: rootDir, detached: true, windowsHide: true, stdio: 'ignore' });
  launchedChild.unref();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname === '/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(readFileSync(htmlPath, 'utf8'));
    }

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const result = { signedIn: false, account: null };
      try {
        result.account = await az(['account', 'show']);
        result.signedIn = !!result.account;
      } catch { /* not signed in */ }
      return sendJson(response, 200, result);
    }

    if (url.pathname === '/api/login-start' && request.method === 'POST') {
      const body = await readJson(request);
      const info = await startBrowserLogin(body.tenantId);
      return sendJson(response, 200, info);
    }

    if (url.pathname === '/api/login-device-code' && request.method === 'POST') {
      const body = await readJson(request);
      const info = await startDeviceCodeLogin(body.tenantId);
      return sendJson(response, 200, info);
    }

    if (url.pathname === '/api/login-poll' && request.method === 'GET') {
      if (loginState.state === 'success') {
        try {
          const account = await az(['account', 'show']);
          return sendJson(response, 200, { state: 'success', account });
        } catch (error) {
          return sendJson(response, 200, { state: 'failed', error: String(error.message) });
        }
      }
      return sendJson(response, 200, loginState);
    }

    if (url.pathname === '/api/login-cancel' && request.method === 'POST') {
      killActiveLogin();
      loginState = { state: 'idle' };
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname === '/api/prerequisites' && request.method === 'GET') {
      const result = await checkPrerequisites();
      return sendJson(response, 200, result);
    }

    if (url.pathname === '/api/prerequisites/install' && request.method === 'POST') {
      const { tool } = await readJson(request);
      try {
        await installPrerequisite(tool);
        const status = await checkPrerequisites();
        return sendJson(response, 200, { ok: true, status });
      } catch (error) {
        return sendJson(response, 500, { error: String(error?.stderr || error?.message || error) });
      }
    }

    if (url.pathname === '/api/subscriptions' && request.method === 'GET') {
      const subs = await az(['account', 'list']);
      return sendJson(response, 200, subs || []);
    }

    if (url.pathname === '/api/subscription' && request.method === 'POST') {
      const { subscriptionId } = await readJson(request);
      await az(['account', 'set', '--subscription', subscriptionId]);
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname === '/api/foundry-accounts' && request.method === 'GET') {
      const accounts = await az(['cognitiveservices', 'account', 'list']);
      const filtered = (accounts || [])
        .filter(a => ['AIServices', 'OpenAI'].includes(a.kind))
        .map(a => {
          const endpoints = a.properties?.endpoints || {};
          const endpoint = endpoints['OpenAI Language Model Instance API']
            || endpoints['Azure OpenAI Legacy API - Latest moniker']
            || a.properties?.endpoint
            || `https://${a.name}.openai.azure.com/`;
          return {
            name: a.name,
            kind: a.kind,
            endpoint,
            resourceGroup: a.id.split('/')[4],
            location: a.location,
            disableLocalAuth: !!a.properties?.disableLocalAuth
          };
        });
      return sendJson(response, 200, filtered);
    }

    if (url.pathname === '/api/resource-groups' && request.method === 'GET') {
      const groups = await az(['group', 'list']);
      const mapped = (groups || []).map(g => ({ name: g.name, location: g.location }));
      return sendJson(response, 200, mapped);
    }

    if (url.pathname === '/api/foundry-locations' && request.method === 'GET') {
      const preferred = ['eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'southcentralus', 'northcentralus', 'westeurope', 'northeurope', 'swedencentral', 'switzerlandnorth', 'uksouth', 'francecentral', 'australiaeast', 'japaneast', 'canadaeast'];
      try {
        const locs = await az(['account', 'list-locations']);
        const known = new Set((locs || []).map(l => l.name));
        const filtered = preferred.filter(p => known.has(p));
        return sendJson(response, 200, filtered.length ? filtered : preferred);
      } catch {
        return sendJson(response, 200, preferred);
      }
    }

    if (url.pathname === '/api/create-foundry' && request.method === 'POST') {
      const { name, resourceGroup, location, createGroup, sku } = await readJson(request);
      if (!name || !resourceGroup || !location) {
        return sendJson(response, 400, { error: 'name, resourceGroup and location are required' });
      }
      try {
        if (createGroup) {
          await az(['group', 'create', '--name', resourceGroup, '--location', location]);
        }
        const created = await az([
          'cognitiveservices', 'account', 'create',
          '--name', name,
          '--resource-group', resourceGroup,
          '--kind', 'AIServices',
          '--sku', sku || 'S0',
          '--location', location,
          '--yes'
        ]);
        return sendJson(response, 200, {
          name: created.name,
          kind: created.kind,
          resourceGroup,
          location: created.location || location,
          endpoint: created.properties?.endpoint || `https://${name}.openai.azure.com/`
        });
      } catch (error) {
        return sendJson(response, 500, { error: String(error.stderr || error.message) });
      }
    }

    if (url.pathname === '/api/deployments' && request.method === 'GET') {
      const name = url.searchParams.get('name');
      const rg = url.searchParams.get('resourceGroup');
      const deps = await az(['cognitiveservices', 'account', 'deployment', 'list', '--name', name, '--resource-group', rg]);
      const mapped = (deps || []).map(d => ({
        name: d.name,
        model: d.properties?.model?.name,
        version: d.properties?.model?.version,
        sku: d.sku?.name
      }));
      return sendJson(response, 200, mapped);
    }

    if (url.pathname === '/api/keys' && request.method === 'GET') {
      const name = url.searchParams.get('name');
      const rg = url.searchParams.get('resourceGroup');
      try {
        const keys = await az(['cognitiveservices', 'account', 'keys', 'list', '--name', name, '--resource-group', rg]);
        return sendJson(response, 200, { key: keys?.key1 || null });
      } catch (error) {
        return sendJson(response, 200, { key: null, error: String(error.stderr || error.message) });
      }
    }

    if (url.pathname === '/api/save-and-launch' && request.method === 'POST') {
      const values = await readJson(request);
      writeEnv(values);
      launchApp(values.port || 3000);
      return sendJson(response, 200, { url: `http://localhost:${values.port || 3000}/` });
    }

    if (url.pathname === '/api/app-ready' && request.method === 'GET') {
      try {
        const r = await fetch(`http://127.0.0.1:${launchedPort}/api/config`, { signal: AbortSignal.timeout(1000) });
        return sendJson(response, 200, { ready: r.ok });
      } catch {
        return sendJson(response, 200, { ready: false });
      }
    }

    if (url.pathname === '/api/shutdown' && request.method === 'POST') {
      sendJson(response, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    const message = (error.stderr && String(error.stderr)) || error.message || 'Unknown error';
    sendJson(response, 500, { error: message });
    console.error(error);
  }
});

// Prerequisite check registry: each entry knows how to detect and (optionally) install a tool.
const prerequisites = [
  {
    key: 'node',
    label: 'Node.js',
    required: '22 or later',
    detect: async () => {
      const { stdout } = await execFileAsync(process.execPath, ['--version']);
      return { installed: true, version: stdout.trim().replace(/^v/, '') };
    },
    winget: null // Wizard already runs on Node — self-referential install not supported here.
  },
  {
    key: 'azcli',
    label: 'Azure CLI',
    required: 'any recent version',
    detect: async () => {
      const cmd = process.platform === 'win32' ? 'az.cmd' : 'az';
      const { stdout } = await execFileAsync(cmd, ['version', '--output', 'json'], { shell: useShell, timeout: 15_000 });
      const j = JSON.parse(stdout);
      return { installed: true, version: j['azure-cli'] };
    },
    winget: 'Microsoft.AzureCLI'
  },
  {
    key: 'python',
    label: 'Python',
    required: '3.9 or later (only for Auto Evaluation toolkit)',
    detect: async () => {
      const cmd = process.platform === 'win32' ? 'python' : 'python3';
      const { stdout } = await execFileAsync(cmd, ['--version'], { shell: useShell, timeout: 10_000 });
      return { installed: true, version: stdout.trim().replace(/^Python /i, '') };
    },
    winget: 'Python.Python.3.12'
  },
  {
    key: 'git',
    label: 'Git',
    required: 'any recent version (only for Auto Evaluation toolkit)',
    detect: async () => {
      const { stdout } = await execFileAsync('git', ['--version'], { shell: useShell, timeout: 10_000 });
      return { installed: true, version: stdout.trim().replace(/^git version /i, '') };
    },
    winget: 'Git.Git'
  }
];

async function checkPrerequisites() {
  const results = {};
  for (const p of prerequisites) {
    try {
      const r = await p.detect();
      results[p.key] = {
        label: p.label,
        required: p.required,
        installed: !!r.installed,
        version: r.version || null,
        canInstall: process.platform === 'win32' && !!p.winget
      };
    } catch {
      results[p.key] = {
        label: p.label,
        required: p.required,
        installed: false,
        version: null,
        canInstall: process.platform === 'win32' && !!p.winget
      };
    }
  }
  return { tools: results, platform: process.platform };
}

async function installPrerequisite(key) {
  const spec = prerequisites.find((p) => p.key === key);
  if (!spec) throw new Error(`Unknown tool: ${key}`);
  if (!spec.winget) throw new Error(`${spec.label} cannot be installed automatically from the wizard.`);
  if (process.platform !== 'win32') throw new Error('Automatic install is only supported on Windows (via winget).');
  await execFileAsync('winget', [
    'install', '--id', spec.winget,
    '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements',
    '--silent'
  ], { shell: useShell, timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  return true;
}

const port = Number(process.env.SETUP_PORT) || 3100;
server.listen(port, '127.0.0.1', () => console.log(`Setup wizard listening on http://localhost:${port}/`));
