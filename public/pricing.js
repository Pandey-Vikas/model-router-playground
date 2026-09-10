// Shared price and tier catalog used by server (analytics) and browser (per-response chips).
// Prices are approximate USD per 1M tokens for demo purposes only.

export const PRICING = {
  'gpt-4.1-nano':   { input: 0.10, output: 0.40, tier: 'nano' },
  'gpt-4.1-mini':   { input: 0.40, output: 1.60, tier: 'mini' },
  'gpt-4.1':        { input: 2.00, output: 8.00, tier: 'standard' },
  'gpt-4o-mini':    { input: 0.15, output: 0.60, tier: 'mini' },
  'gpt-4o':         { input: 2.50, output: 10.00, tier: 'standard' },
  'gpt-5-nano':     { input: 0.05, output: 0.40, tier: 'nano' },
  'gpt-5-mini':     { input: 0.25, output: 2.00, tier: 'mini' },
  'gpt-5':          { input: 1.25, output: 10.00, tier: 'standard' },
  'gpt-5.2':        { input: 1.50, output: 12.00, tier: 'advanced' },
  'gpt-5.4-nano':   { input: 0.08, output: 0.50, tier: 'nano' },
  'gpt-5.4-mini':   { input: 0.35, output: 2.50, tier: 'mini' },
  'gpt-5.4':        { input: 2.00, output: 15.00, tier: 'advanced' },
  'gpt-5.5':        { input: 2.50, output: 18.00, tier: 'advanced' },
  'gpt-5.6-sol':    { input: 3.00, output: 24.00, tier: 'frontier' },
  'gpt-5.6-terra':  { input: 3.00, output: 24.00, tier: 'frontier' },
  'gpt-5.6-luna':   { input: 3.00, output: 24.00, tier: 'frontier' },
  'o4-mini':        { input: 1.10, output: 4.40, tier: 'reasoning' },
  'claude-opus-4-8':   { input: 15.00, output: 75.00, tier: 'frontier' },
  'claude-opus-4-7':   { input: 15.00, output: 75.00, tier: 'frontier' },
  'claude-opus-4-6':   { input: 15.00, output: 75.00, tier: 'frontier' },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, tier: 'advanced' },
  'claude-haiku-4-5':  { input: 0.80, output: 4.00, tier: 'mini' },
  'grok-4':                  { input: 5.00, output: 15.00, tier: 'advanced' },
  'grok-4-1-fast-reasoning': { input: 3.00, output: 15.00, tier: 'reasoning' },
  'deepseek-v3.2':                              { input: 0.30, output: 1.20, tier: 'open' },
  'gpt-oss-120b':                               { input: 0.20, output: 0.80, tier: 'open' },
  'llama-4-maverick-17b-128e-instruct-fp8':     { input: 0.20, output: 0.90, tier: 'open' }
};

export const BASELINE_MODEL = 'claude-opus-4-8';
export const DEFAULT_PRICE = { input: 1.00, output: 4.00, tier: 'standard' };
export const TIER_ORDER = ['nano', 'mini', 'standard', 'advanced', 'reasoning', 'frontier', 'open'];

export function normalizeModelName(raw) {
  if (!raw) return 'unknown';
  return String(raw).toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
}

export function priceFor(model) {
  return PRICING[normalizeModelName(model)] || DEFAULT_PRICE;
}

export function tierFor(model) {
  return priceFor(model).tier;
}

export function calculateCost(model, promptTokens = 0, completionTokens = 0) {
  const price = priceFor(model);
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}
