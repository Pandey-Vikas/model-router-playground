import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function patchClient() {
  const clientPath = join(rootDir, 'eval-toolkit', 'src', 'client.py');
  if (!existsSync(clientPath)) return console.log('client.py not found');
  let source = readFileSync(clientPath, 'utf8');
  if (source.includes('_entra_token_provider')) return console.log('client.py already patched');
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
  const marker = 'def _build_client(endpoint_config: EndpointConfig)';
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) return console.log('client.py marker not found');
  const before = source.substring(0, markerIdx);
  const after = source.substring(markerIdx);
  const endIdx = after.indexOf('\nclass ');
  if (endIdx < 0) return console.log('client.py end marker not found');
  const rest = after.substring(endIdx);
  writeFileSync(clientPath, before + helper + patchedFn + rest, 'utf8');
  console.log('Patched src/client.py for Entra ID.');
}

function patchJudge() {
  const judgePath = join(rootDir, 'eval-toolkit', 'src', 'judge.py');
  if (!existsSync(judgePath)) return console.log('judge.py not found');
  let source = readFileSync(judgePath, 'utf8');
  if (source.includes('_entra_token_provider')) return console.log('judge.py already patched');
  const patchedFn = `def _build_judge_client(config: EndpointConfig) -> AsyncAzureOpenAI | AsyncOpenAI:
    """Build an async client for the judge model."""
    if config.type == "azure_openai":
        if config.api_key:
            return AsyncAzureOpenAI(
                azure_endpoint=config.endpoint_url,
                api_key=config.api_key,
                api_version="2024-12-01-preview",
            )
        return AsyncAzureOpenAI(
            azure_endpoint=config.endpoint_url,
            azure_ad_token_provider=_entra_token_provider,
            api_version="2024-12-01-preview",
        )
    elif config.type == "openai_compatible":
        return AsyncOpenAI(
            base_url=config.endpoint_url,
            api_key=config.api_key,
        )
    else:
        raise ValueError(f"Unknown judge endpoint type: '{config.type}'")`;
  const marker = 'def _build_judge_client(config: EndpointConfig)';
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) return console.log('judge.py marker not found');
  const before = source.substring(0, markerIdx);
  const after = source.substring(markerIdx);
  const endIdx = after.indexOf('\nclass ');
  if (endIdx < 0) return console.log('judge.py end marker not found');
  const rest = after.substring(endIdx);
  writeFileSync(judgePath, before + helper + patchedFn + rest, 'utf8');
  console.log('Patched src/judge.py for Entra ID.');
}

patchClient();
patchJudge();
