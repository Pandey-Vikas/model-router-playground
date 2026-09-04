import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeModelName } from '../../public/pricing.js';
import { pushLog } from '../logs.js';

const execFileAsync = promisify(execFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when MODEL_PROVIDER=foundry`);
  return value;
}

const DEFAULT_SYSTEM_PROMPT = 'Be brief.';

let cachedToken = null;

async function getEntraToken() {
  if (cachedToken && cachedToken.expiresOn - Date.now() > 60_000) return cachedToken.token;
  const azCommand = process.platform === 'win32' ? 'az.cmd' : 'az';
  try {
    const { stdout } = await execFileAsync(azCommand, ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--output', 'json'], { shell: process.platform === 'win32' });
    const parsed = JSON.parse(stdout);
    cachedToken = { token: parsed.accessToken, expiresOn: new Date(parsed.expiresOn).getTime() };
    return cachedToken.token;
  } catch (error) {
    throw new Error(`Could not acquire Microsoft Entra token via Azure CLI. Run "az login" and ensure you have the "Cognitive Services OpenAI User" role. Original error: ${error.stderr || error.message}`);
  }
}

export async function foundryChat({ messages, routingMode, deploymentOverride }) {
  const endpoint = required('AZURE_OPENAI_ENDPOINT').replace(/\/$/, '');
  const modeKey = ['balanced', 'cost', 'quality'].includes(routingMode) ? routingMode : 'balanced';
  const modeDeployment = process.env[`MODEL_ROUTER_DEPLOYMENT_${modeKey.toUpperCase()}`];
  const deployment = deploymentOverride || modeDeployment || required('MODEL_ROUTER_DEPLOYMENT_NAME');
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-11-18';
  const systemPrompt = process.env.MODEL_ROUTER_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const maxTokensEnv = process.env.MODEL_ROUTER_MAX_OUTPUT_TOKENS;
  const maxTokens = maxTokensEnv ? Number(maxTokensEnv) : null;
  const timeoutMs = Number(process.env.MODEL_ROUTER_TIMEOUT_MS) || 120_000;

  const authHeaders = apiKey ? { 'api-key': apiKey } : { authorization: `Bearer ${await getEntraToken()}` };

  const payload = messages[0]?.role === 'system' || !systemPrompt ? messages : [{ role: 'system', content: systemPrompt }, ...messages];
  const requestUrl = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  pushLog({ kind: 'request', method: 'POST', url: requestUrl, deployment, routingMode: modeKey, auth: apiKey ? 'api-key' : 'entra-id', messageCount: payload.length, maxTokens: maxTokens || 'model default' });
  const startedAt = performance.now();
  const requestBody = { messages: payload };
  if (maxTokens) requestBody.max_completion_tokens = maxTokens;
  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    pushLog({ kind: 'error', url: requestUrl, latencyMs: Math.round(performance.now() - startedAt), error: error.message });
    throw error;
  }
  const requestId = response.headers.get('x-request-id') || response.headers.get('apim-request-id');
  const body = await response.json();
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const message = body.error?.message || `Foundry request failed (${response.status})`;
    pushLog({ kind: 'response', status: response.status, ok: false, latencyMs, requestId, error: message });
    throw new Error(message);
  }
  const usage = body.usage || {};
  pushLog({
    kind: 'response',
    status: response.status,
    ok: true,
    latencyMs,
    requestId,
    routedModel: normalizeModelName(body.model) || 'unknown',
    routedModelRaw: body.model,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0
  });

  return {
    content: body.choices?.[0]?.message?.content || '',
    routedModel: normalizeModelName(body.model) || 'unknown',
    routedModelRaw: body.model || null,
    provider: 'foundry',
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    latencyMs: Math.round(performance.now() - startedAt),
    finishReason: body.choices?.[0]?.finish_reason || null,
    requestId: requestId || body.id || null
  };
}