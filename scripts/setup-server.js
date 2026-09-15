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
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function ensureFoundryProject({ subscriptionId, resourceGroup, account, projectName, location }) {
  const tokenObj = await az(['account', 'get-access-token', '--resource', 'https://management.azure.com']);
  const token = tokenObj?.accessToken;
  if (!token) throw new Error('Could not acquire ARM access token for project creation');
  const base = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(account)}/projects`;
  const apiVersion = '2025-04-01-preview';
  const listRes = await fetch(`${base}?api-version=${apiVersion}`, { headers: { authorization: `Bearer ${token}` } });
  if (listRes.ok) {
    const listBody = await listRes.json();
    const existing = (listBody.value || [])[0];
    if (existing) return { name: existing.name, id: existing.id, created: false };
  }
  const target = projectName || 'default-project';
  const putRes = await fetch(`${base}/${encodeURIComponent(target)}?api-version=${apiVersion}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ location, identity: { type: 'SystemAssigned' }, properties: {} })
  });
  const putBody = await putRes.json().catch(() => ({}));
  if (!putRes.ok) throw new Error(putBody.error?.message || `Project create failed (${putRes.status})`);
  return { name: putBody.name?.split('/').pop() || target, id: putBody.id, created: true };
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
  if (values.foundryName) lines.push(`AZURE_FOUNDRY_RESOURCE_NAME=${values.foundryName}`);
  if (values.foundryResourceGroup) lines.push(`AZURE_FOUNDRY_RESOURCE_GROUP=${values.foundryResourceGroup}`);
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
          // AI Services accounts route AOAI-compatible calls through .cognitiveservices.azure.com.
          // Legacy OpenAI kind uses .openai.azure.com.
          // The regional endpoint (properties.endpoints[*] all point to <region>.api.cognitive.microsoft.com)
          // does NOT route chat completions to a specific resource — never use it here.
          const suffix = a.kind === 'OpenAI' ? 'openai.azure.com' : 'cognitiveservices.azure.com';
          const endpoint = `https://${a.name}.${suffix}`;
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
        if (!Array.isArray(locs) || !locs.length) return sendJson(response, 200, preferred.map((n) => ({ name: n, displayName: n, preferred: true })));
        const preferredSet = new Set(preferred);
        const rich = locs
          .filter((l) => l && l.metadata && (l.metadata.regionType || '').toLowerCase() === 'physical')
          .map((l) => ({ name: l.name, displayName: l.displayName || l.name, preferred: preferredSet.has(l.name) }))
          .sort((a, b) => {
            if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
            return a.displayName.localeCompare(b.displayName);
          });
        return sendJson(response, 200, rich);
      } catch {
        return sendJson(response, 200, preferred.map((n) => ({ name: n, displayName: n, preferred: true })));
      }
    }

    if (url.pathname === '/api/create-resource-group' && request.method === 'POST') {
      const { name, location } = await readJson(request);
      if (!name || !location) {
        return sendJson(response, 400, { error: 'name and location are required' });
      }
      try {
        const existing = await az(['group', 'exists', '--name', name]);
        if (existing === true || String(existing).toLowerCase() === 'true') {
          return sendJson(response, 200, { name, location, existed: true });
        }
        const rg = await az(['group', 'create', '--name', name, '--location', location]);
        return sendJson(response, 200, { name: rg?.name || name, location: rg?.location || location, existed: false });
      } catch (error) {
        return sendJson(response, 500, { error: String(error.stderr || error.message) });
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
          '--custom-domain', name,
          '--yes'
        ]);
        // Create a default Foundry project so the account is visible in the new Foundry portal (ai.azure.com)
        // and so project-scoped roles (Azure AI User / Azure AI Project Manager) can be assigned.
        let project = null;
        try {
          const sub = await az(['account', 'show']);
          if (sub?.id) {
            project = await ensureFoundryProject({
              subscriptionId: sub.id,
              resourceGroup,
              account: name,
              projectName: 'default-project',
              location: created.location || location
            });
          }
        } catch (e) { /* project best-effort — account still usable via classic path */ }
        // Grant the signed-in user the minimum roles needed for Entra ID chat completions to work immediately.
        // Account-scope: Cognitive Services User + OpenAI User. Project-scope: Azure AI User + Project Manager.
        const grantedRoles = [];
        const skippedRoles = [];
        try {
          const me = await az(['ad', 'signed-in-user', 'show']);
          const oid = me?.id;
          const sub = await az(['account', 'show']);
          const accountScope = `/subscriptions/${sub?.id}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${name}`;
          const projectScope = project?.name ? `${accountScope}/projects/${project.name}` : null;
          if (oid && sub?.id) {
            const grants = [
              { role: 'Cognitive Services User', scope: accountScope },
              { role: 'Cognitive Services OpenAI User', scope: accountScope },
              ...(projectScope ? [
                { role: 'Azure AI User', scope: projectScope },
                { role: 'Azure AI Project Manager', scope: projectScope }
              ] : [])
            ];
            for (const { role, scope } of grants) {
              try {
                await az(['role', 'assignment', 'create', '--assignee-object-id', oid, '--assignee-principal-type', 'User', '--role', role, '--scope', scope]);
                grantedRoles.push(role);
              } catch (e) {
                const reason = String(e.stderr || e.message).split('\n')[0].slice(0, 200);
                // If the role already exists on this scope, count it as a success — the user does have access.
                if (/already exists|role assignment.*exists/i.test(reason)) grantedRoles.push(role);
                else skippedRoles.push({ role, reason });
              }
            }
          } else {
            skippedRoles.push({ role: 'ALL', reason: 'Could not resolve signed-in user or subscription id' });
          }
        } catch (e) {
          skippedRoles.push({ role: 'ALL', reason: String(e.stderr || e.message).slice(0, 200) });
        }
        // Fail visibly if none of the data-plane roles landed at account scope — the demo will 401 otherwise.
        const hasDataPlane = grantedRoles.includes('Cognitive Services User') || grantedRoles.includes('Cognitive Services OpenAI User');
        if (!hasDataPlane) {
          return sendJson(response, 500, {
            error: 'Account was created but no data-plane role could be granted. Chat completions will return 401. First skipped role: ' +
              (skippedRoles[0]?.role || 'unknown') + ' — ' + (skippedRoles[0]?.reason || 'no details') +
              '. Fix: grant "Cognitive Services User" and "Cognitive Services OpenAI User" manually, then click Refresh.',
            name: created.name,
            resourceGroup,
            skippedRoles
          });
        }
        return sendJson(response, 200, {
          name: created.name,
          kind: created.kind,
          resourceGroup,
          location: created.location || location,
          project: project?.name || null,
          grantedRoles,
          skippedRoles,
          // Newly-created accounts are always AIServices kind — use the .cognitiveservices.azure.com subdomain,
          // NOT the regional endpoint that comes back in created.properties.endpoint.
          endpoint: `https://${created.name || name}.cognitiveservices.azure.com`
        });
      } catch (error) {
        return sendJson(response, 500, { error: String(error.stderr || error.message) });
      }
    }

    if (url.pathname === '/api/grant-access' && request.method === 'POST') {
      const { account, resourceGroup } = await readJson(request);
      if (!account || !resourceGroup) {
        return sendJson(response, 400, { error: 'account and resourceGroup are required' });
      }
      try {
        const me = await az(['ad', 'signed-in-user', 'show']);
        const oid = me?.id;
        const sub = await az(['account', 'show']);
        if (!oid || !sub?.id) throw new Error('Could not resolve signed-in user or subscription');
        const accountScope = `/subscriptions/${sub.id}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${account}`;
        // Look up the account's location so we can create a project in the matching region if one doesn't exist yet.
        let project = null;
        try {
          const acct = await az(['cognitiveservices', 'account', 'show', '--name', account, '--resource-group', resourceGroup]);
          if (acct?.properties?.allowProjectManagement) {
            project = await ensureFoundryProject({
              subscriptionId: sub.id,
              resourceGroup,
              account,
              projectName: 'default-project',
              location: acct.location
            });
          }
        } catch { /* leave project unset */ }
        const projectScope = project?.name ? `${accountScope}/projects/${project.name}` : null;
        const grants = [
          { role: 'Cognitive Services User', scope: accountScope },
          { role: 'Cognitive Services OpenAI User', scope: accountScope },
          ...(projectScope ? [
            { role: 'Azure AI User', scope: projectScope },
            { role: 'Azure AI Project Manager', scope: projectScope }
          ] : [])
        ];
        const granted = [];
        const skipped = [];
        for (const { role, scope } of grants) {
          try {
            await az(['role', 'assignment', 'create', '--assignee-object-id', oid, '--assignee-principal-type', 'User', '--role', role, '--scope', scope]);
            granted.push(role);
          } catch (e) {
            skipped.push({ role, reason: String(e.stderr || e.message).split('\n')[0].slice(0, 120) });
          }
        }
        return sendJson(response, 200, { granted, skipped, project: project?.name || null, upn: me?.userPrincipalName || me?.mail || null });
      } catch (error) {
        return sendJson(response, 500, { error: String(error.stderr || error.message) });
      }
    }

    if (url.pathname === '/api/deploy-router' && request.method === 'POST') {
      const { account, resourceGroup, deploymentName, mode, capacity, version } = await readJson(request);
      if (!account || !resourceGroup || !deploymentName || !mode) {
        return sendJson(response, 400, { error: 'account, resourceGroup, deploymentName and mode are required' });
      }
      if (!['balanced', 'cost', 'quality'].includes(String(mode).toLowerCase())) {
        return sendJson(response, 400, { error: 'mode must be balanced, cost or quality' });
      }
      try {
        const sub = await az(['account', 'show']);
        const subscriptionId = sub?.id;
        if (!subscriptionId) throw new Error('Could not resolve subscription id from az account show');
        const tokenObj = await az(['account', 'get-access-token', '--resource', 'https://management.azure.com']);
        const token = tokenObj?.accessToken;
        if (!token) throw new Error('Could not acquire ARM access token');
        const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(account)}/deployments/${encodeURIComponent(deploymentName)}?api-version=2025-10-01-preview`;
        const body = {
          sku: { name: 'GlobalStandard', capacity: Number(capacity) || 10 },
          properties: {
            model: { format: 'OpenAI', name: 'model-router', version: version || '2025-11-18' },
            routing: { mode: String(mode).toLowerCase() }
          }
        };
        const res = await fetch(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000)
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text;
          try { msg = JSON.parse(text)?.error?.message || text; } catch { /* keep raw */ }
          throw new Error(`Deploy failed (${res.status}): ${String(msg).slice(0, 300)}`);
        }
        const parsed = text ? JSON.parse(text) : {};
        return sendJson(response, 200, {
          name: parsed.name || deploymentName,
          mode: String(mode).toLowerCase(),
          model: parsed.properties?.model?.name || 'model-router',
          version: parsed.properties?.model?.version || (version || '2025-11-18'),
          provisioningState: parsed.properties?.provisioningState || 'Requested'
        });
      } catch (error) {
        return sendJson(response, 500, { error: String(error?.stderr || error?.message || error) });
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
      const { stdout } = await execFileAsync(cmd, ['version', '--output', 'json'], { shell: useShell, windowsHide: true, timeout: 15_000 });
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
      const { stdout } = await execFileAsync(cmd, ['--version'], { shell: useShell, windowsHide: true, timeout: 10_000 });
      return { installed: true, version: stdout.trim().replace(/^Python /i, '') };
    },
    winget: 'Python.Python.3.12'
  },
  {
    key: 'git',
    label: 'Git',
    required: 'any recent version (only for Auto Evaluation toolkit)',
    detect: async () => {
      const { stdout } = await execFileAsync('git', ['--version'], { shell: useShell, windowsHide: true, timeout: 10_000 });
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
  ], { shell: useShell, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  return true;
}

const port = Number(process.env.SETUP_PORT) || 3100;
server.listen(port, '127.0.0.1', () => console.log(`Setup wizard listening on http://localhost:${port}/`));
