import { randomUUID } from 'node:crypto';

const routedModels = [
  { max: 2, model: 'gpt-4.1-nano' },
  { max: 4, model: 'gpt-4.1-mini' },
  { max: 6, model: 'gpt-5-mini' },
  { max: 8, model: 'gpt-5' },
  { max: 10, model: 'o4-mini' }
];

export async function mockChat({ messages, complexityLevel }) {
  const level = complexityLevel || 5;
  const routedModel = routedModels.find((entry) => level <= entry.max).model;
  const userText = messages.at(-1)?.content || '';
  const promptTokens = Math.max(12, Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4));
  const completionTokens = 24 + level * 19;
  const latencyMs = 220 + level * 180;
  await new Promise((resolve) => setTimeout(resolve, latencyMs));

  return {
    content: `Mock response for complexity ${level}/10. The router selected ${routedModel} for: “${userText.slice(0, 110)}${userText.length > 110 ? '…' : ''}”\n\nConnect a Foundry endpoint to replace this simulation with a live response while keeping the same telemetry and history experience.`,
    routedModel,
    provider: 'mock',
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens: level >= 7 ? level * 12 : 0,
    cachedTokens: messages.length > 1 ? Math.round(promptTokens * 0.25) : 0,
    latencyMs,
    finishReason: 'stop',
    requestId: `mock-${randomUUID()}`
  };
}