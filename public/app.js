import { tierFor, calculateCost, BASELINE_MODEL, priceFor } from '/pricing.js';

const state = { conversations: [], conversation: null, scenarios: [], provider: 'mock', analytics: null, ladderRunning: false, ladderStopRequested: false, routingMode: 'balanced', deployments: {}, benchmarkRunning: false };
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));

async function api(path, options) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  setTimeout(() => elements.toast.classList.remove('show'), 3500);
}

async function refreshFoundryHealth() {
  try {
    const info = await api('/api/health/foundry');
    applyFoundryHealth(info);
  } catch { applyFoundryHealth({ ok: false, error: 'health probe failed' }); }
}

function applyFoundryHealth(info) {
  state.foundryHealth = info;
  const dot = document.querySelector('.provider-status .status-dot');
  const badge = document.querySelector('.header-badge span');
  if (info.ok === true) {
    if (dot) { dot.style.background = '#38a06d'; dot.style.boxShadow = '0 0 0 1px #38a06d'; }
    if (badge) badge.style.background = '#38a06d';
    if (elements.providerHint) elements.providerHint.textContent = `Live endpoint reachable · HTTP ${info.status ?? '?'}`;
    setActionsGuarded(false);
  } else if (info.ok === false) {
    if (dot) { dot.style.background = '#d9534f'; dot.style.boxShadow = '0 0 0 1px #d9534f'; }
    if (badge) badge.style.background = '#d9534f';
    if (elements.providerHint) elements.providerHint.textContent = 'Endpoint unreachable' + (info.error ? ` · ${info.error.slice(0, 60)}` : '');
    if (elements.headerProvider) elements.headerProvider.textContent = 'FOUNDRY UNREACHABLE';
    setActionsGuarded(true);
  } else {
    if (dot) { dot.style.background = '#e0a54a'; dot.style.boxShadow = '0 0 0 1px #e0a54a'; }
    if (badge) badge.style.background = '#e0a54a';
  }
}

function setActionsGuarded(unreachable) {
  const disable = !!unreachable;
  const tip = disable ? 'Foundry endpoint is unreachable. Click ⚙ Change environment in the sidebar to fix.' : '';
  const ids = ['sendButton', 'messageInput', 'runLadderButton', 'runLadderQuickButton', 'benchRunButton', 'evalRunButton', 'evalDryRunButton', 'evalRun3ModesButton'];
  for (const id of ids) {
    const el = elements[id];
    if (!el) continue;
    el.disabled = disable || el.dataset.busy === '1';
    if (disable) el.title = tip; else el.removeAttribute('title');
  }
  let banner = document.getElementById('foundryDownBanner');
  if (disable) {
    if (!banner && elements.chatPanel) {
      banner = document.createElement('div');
      banner.id = 'foundryDownBanner';
      banner.className = 'foundry-down-banner';
      banner.innerHTML = '<strong>⚠ Foundry endpoint is unreachable.</strong> Chat, benchmark, and eval are disabled. Click <b>⚙ Change environment</b> in the sidebar to point at a working endpoint, then reload.';
      elements.chatPanel.insertBefore(banner, elements.chatPanel.firstChild);
    }
  } else if (banner) {
    banner.remove();
  }
}

function formatCost(value) {
  if (!Number.isFinite(value) || value === 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function nearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 120;
}

function renderHistory() {
  elements.historyCount.textContent = state.conversations.length;
  elements.historyList.innerHTML = state.conversations.map((conversation) => `
    <div class="history-item ${state.conversation?.id === conversation.id ? 'active' : ''}">
      <button class="history-open" type="button" data-conversation="${conversation.id}">
        <strong>${escapeHtml(conversation.title)}</strong>
        <small>${Math.floor((conversation.message_count || 0) / 2)} prompts · ${escapeHtml(conversation.last_model || 'No model yet')}</small>
      </button>
      <button class="history-delete" type="button" data-delete="${conversation.id}" aria-label="Delete conversation">×</button>
    </div>`).join('');
}

function messageMarkup(message) {
  if (message.role !== 'assistant') {
    return `<article class="message user"><div class="message-body"><div class="message-content">${escapeHtml(message.content)}</div></div></article>`;
  }
  if (message.pending) {
    return `<article class="message assistant pending">
      <div class="message-avatar">MR</div>
      <div class="message-body">
        <div class="thinking"><span></span><span></span><span></span></div>
        <div class="thinking-label">${escapeHtml(message.pendingLabel || 'Routing to the best model…')}</div>
      </div>
    </article>`;
  }
  const tier = message.tier || tierFor(message.routed_model);
  const price = priceFor(message.routed_model);
  const inputTokens = message.prompt_tokens || 0;
  const outputTokens = message.completion_tokens || 0;
  const storedInputRate = Number(message.input_rate_usd_per_million);
  const storedOutputRate = Number(message.output_rate_usd_per_million);
  const inputRate = Number.isFinite(storedInputRate) ? storedInputRate : price.input;
  const outputRate = Number.isFinite(storedOutputRate) ? storedOutputRate : price.output;
  const inputCost = (inputTokens * inputRate) / 1_000_000;
  const outputCost = (outputTokens * outputRate) / 1_000_000;
  const storedCost = Number(message.cost_usd);
  const cost = Number.isFinite(storedCost) ? storedCost : calculateCost(message.routed_model, inputTokens, outputTokens);
  const costTooltip = [
    `Model: ${message.routed_model || 'unknown'}`,
    `Input:  ${inputTokens} tokens × $${inputRate.toFixed(2)} per 1M = ${formatCost(inputCost)}`,
    `Output: ${outputTokens} tokens × $${outputRate.toFixed(2)} per 1M = ${formatCost(outputCost)}`,
    `Total:  ${formatCost(cost)}`,
    message.rate_source ? `Rate captured at request time (source: ${message.rate_source})` : 'Rates from public/pricing.js'
  ].join('\n');
  const emptyByLength = !message.content && message.finish_reason === 'length';
  const bodyHtml = emptyByLength
    ? '<div class="message-content empty-warning">⚠️ The model used all output tokens for internal reasoning and returned no visible text. Set <code>MODEL_ROUTER_MAX_OUTPUT_TOKENS</code> in .env to a larger number, or try a less reasoning-heavy prompt.</div>'
    : `<div class="message-content">${escapeHtml(message.content)}</div>`;
  return `<article class="message assistant">
    <div class="message-avatar">MR</div>
    <div class="message-body">
      ${bodyHtml}
      <div class="message-meta">
        <span class="meta-chip model">${escapeHtml(message.routed_model || 'unknown model')}</span>
        <span class="meta-chip tier tier-${tier}">${tier}</span>
        <span class="meta-chip">L${message.complexity_level}</span>
        <span class="meta-chip">${message.total_tokens ?? 0} tokens</span>
        <span class="meta-chip">${message.latency_ms ?? 0} ms</span>
        <button class="meta-chip cost" type="button" data-cost-toggle title="Click to see calculation">${formatCost(cost)}</button>
        ${message.reasoning_tokens ? `<span class="meta-chip">${message.reasoning_tokens} reasoning</span>` : ''}
        ${message.cached_tokens ? `<span class="meta-chip">${message.cached_tokens} cached</span>` : ''}
        <span class="meta-chip">${escapeHtml(message.finish_reason || 'complete')}</span>
        <button class="meta-copy" type="button" data-copy>Copy</button>
      </div>
      <div class="cost-breakdown" hidden>
        <table>
          <tr><td>Model</td><td>${escapeHtml(message.routed_model || 'unknown')}</td><td></td></tr>
          <tr><td>Input tokens</td><td>${inputTokens} × $${inputRate.toFixed(2)} per 1M</td><td>= ${formatCost(inputCost)}</td></tr>
          <tr><td>Output tokens</td><td>${outputTokens} × $${outputRate.toFixed(2)} per 1M</td><td>= ${formatCost(outputCost)}</td></tr>
          <tr class="total"><td>Total</td><td></td><td>= ${formatCost(cost)}</td></tr>
          ${price.source ? `<tr><td>Rate source</td><td colspan="2"><a href="${escapeHtml(price.source)}" target="_blank" rel="noopener">${escapeHtml(price.source)}</a></td></tr>` : ''}
        </table>
        <small>Formula: <code>(input_tokens × input_rate + output_tokens × output_rate) ÷ 1,000,000</code>.
        Token counts come from the Azure OpenAI response. Rates were captured at request time and stored with this message.</small>
      </div>
    </div>
  </article>`;
}

function renderConversation() {
  const messages = state.conversation?.messages || [];
  const shouldScroll = messages.length === 0 || nearBottom(elements.messages);
  elements.conversationTitle.textContent = state.conversation?.title || 'New conversation';
  elements.emptyState.hidden = messages.length > 0;
  [...elements.messages.querySelectorAll('.message')].forEach((message) => message.remove());
  elements.messages.insertAdjacentHTML('beforeend', messages.map(messageMarkup).join(''));
  if (shouldScroll) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderScenarios() {
  elements.scenarioList.innerHTML = state.scenarios.map((scenario) => `
    <button class="scenario" type="button" data-scenario="${scenario.level}">
      <span class="level">${String(scenario.level).padStart(2, '0')}</span>
      <span><strong>${escapeHtml(scenario.title)}</strong><small>${escapeHtml(scenario.category)}</small></span>
      <span class="arrow">›</span>
    </button>`).join('');
}

function renderAnalytics() {
  const analytics = state.analytics;
  if (!analytics) return;
  const summary = analytics.summary;
  elements.metricGrid.innerHTML = [
    ['Responses', summary.responses], ['Models used', summary.models],
    ['Total tokens', Number(summary.total_tokens).toLocaleString()], ['Avg latency', `${summary.avg_latency_ms} ms`]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><small>${label}</small></div>`).join('');

  if (summary.responses > 0 && summary.baseline_cost > 0) {
    elements.costCard.hidden = false;
    const pct = Math.max(0, Math.min(100, summary.savings_pct || 0));
    elements.savingsPct.textContent = `${pct.toFixed(0)}% saved`;
    elements.costBarFill.style.width = `${Math.max(4, 100 - pct)}%`;
    elements.actualCost.textContent = formatCost(summary.actual_cost);
    elements.baselineCost.textContent = formatCost(summary.baseline_cost);
    elements.savedCost.textContent = formatCost(Math.max(0, summary.savings));
    elements.baselineLabel.textContent = `If all on ${summary.baseline_model || BASELINE_MODEL}`;
  } else {
    elements.costCard.hidden = true;
  }

  const maxResponses = Math.max(1, ...analytics.models.map((model) => model.responses));
  elements.modelChart.innerHTML = analytics.models.length ? analytics.models.map((model) => `
    <div class="model-row">
      <div class="model-label"><span>${escapeHtml(model.model)} <span class="tier tier-${model.tier}">${model.tier}</span></span><span>${model.responses} · ${formatCost(model.cost || 0)}</span></div>
      <div class="model-bar tier-bg-${model.tier}"><span style="width:${Math.max(8, model.responses / maxResponses * 100)}%"></span></div>
    </div>`).join('') : '<p class="empty-analytics">Run a scenario to begin building the routing distribution.</p>';

  elements.complexityTrail.innerHTML = analytics.complexity.length ? analytics.complexity.map((row) => `
    <div class="trail-row">
      <span class="trail-level">${row.level}</span>
      <span><strong>${escapeHtml(row.model)}</strong> <span class="tier tier-${row.tier}">${row.tier}</span></span>
      <span>${row.share_pct}% · ${row.avg_tokens} tok · ${row.avg_latency_ms} ms</span>
    </div>`).join('') : '<p class="empty-analytics">No complexity evidence captured yet.</p>';

  renderPricingCatalog(analytics.models);
}

async function renderPricingCatalog(usedModels = []) {
  if (!elements.pricingTable) return;
  try {
    const { catalog, baselineModel, source, currency, unit } = await api('/api/pricing');
    const usedNames = new Set((usedModels || []).map((m) => (m.model || '').toLowerCase()));
    const rows = catalog.map((row) => {
      const isUsed = usedNames.has((row.model || '').toLowerCase());
      const isBaseline = row.model === baselineModel;
      const sourceHost = row.source ? new URL(row.source).host : '';
      return `<tr class="${isUsed ? 'used' : ''} ${isBaseline ? 'baseline' : ''}">
        <td><strong>${escapeHtml(row.model)}</strong>${isBaseline ? ' <span class="pill">baseline</span>' : ''}${isUsed ? ' <span class="pill pill-used">used</span>' : ''}</td>
        <td><span class="tier tier-${escapeHtml(row.tier)}">${escapeHtml(row.tier)}</span></td>
        <td class="num">$${row.input.toFixed(2)}</td>
        <td class="num">$${row.output.toFixed(2)}</td>
        <td class="src">${row.source ? `<a href="${escapeHtml(row.source)}" target="_blank" rel="noopener" title="${escapeHtml(row.source)}">${escapeHtml(sourceHost)}</a>` : '—'}</td>
      </tr>`;
    }).join('');
    elements.pricingTable.innerHTML = `
      <table>
        <thead><tr><th>Model</th><th>Tier</th><th>Input rate<br><small>${escapeHtml(currency)} ${escapeHtml(unit)}</small></th><th>Output rate<br><small>${escapeHtml(currency)} ${escapeHtml(unit)}</small></th><th>Rate source</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <small>Formula per response: <code>cost = (input_tokens × input_rate + output_tokens × output_rate) ÷ 1,000,000</code>.
      Rates are hand-curated in <code>${escapeHtml(source)}</code> from the linked Azure pages (list price, no reservations/PTU/marketplace discounts).
      The rate that was actually used is stored on each message row at the time of the call, so past costs won't change if this catalog is updated later.</small>
    `;
  } catch { elements.pricingTable.innerHTML = '<p class="empty-analytics">Could not load pricing catalog.</p>'; }
}

async function refreshHistory() {
  state.conversations = await api('/api/conversations');
  renderHistory();
}

async function refreshAnalytics() {
  const query = state.conversation?.id ? `?conversationId=${encodeURIComponent(state.conversation.id)}` : '';
  state.analytics = await api(`/api/analytics${query}`);
  renderAnalytics();
}

async function createConversation() {
  try {
    state.conversation = { ...(await api('/api/conversations', { method: 'POST', body: '{}' })), messages: [] };
    await refreshHistory();
    renderConversation();
    closeDrawers();
    await refreshAnalytics();
    elements.messageInput.focus();
  } catch (error) { showToast('Could not create conversation: ' + error.message); }
}

async function openConversation(id) {
  try {
    state.conversation = await api(`/api/conversations/${id}`);
    renderHistory();
    renderConversation();
    closeDrawers();
    await refreshAnalytics();
  } catch (error) { showToast('Could not open conversation: ' + error.message); }
}

async function deleteConversation(id) {
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.conversation?.id === id) state.conversation = null;
    await refreshHistory();
    renderConversation();
    await refreshAnalytics();
  } catch (error) { showToast('Could not delete conversation: ' + error.message); }
}

function setComposerBusy(busy, sendLabel = '↑') {
  elements.sendButton.disabled = busy;
  elements.sendButton.textContent = busy ? '…' : sendLabel;
  elements.messageInput.disabled = busy;
  elements.runLadderButton.disabled = busy || state.ladderRunning;
  if (elements.runLadderQuickButton) elements.runLadderQuickButton.disabled = busy || state.ladderRunning;
}

async function sendPrompt(conversationId, content, complexityLevel, { noHistory = false } = {}) {
  const assistant = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ content, complexityLevel, routingMode: state.routingMode, noHistory })
  });
  return assistant;
}

async function sendMessage() {
  if (state.ladderRunning) return;
  const content = elements.messageInput.value.trim();
  if (!content) return;
  if (!state.conversation) await createConversation();
  const level = Number(elements.complexity.value);
  const optimistic = { role: 'user', content, complexity_level: level };
  const pending = { role: 'assistant', pending: true, pendingLabel: `Routing L${level} to the best model…` };
  state.conversation.messages.push(optimistic, pending);
  renderConversation();
  elements.messageInput.value = '';
  setComposerBusy(true);
  try {
    const assistant = await sendPrompt(state.conversation.id, content, level);
    state.conversation.messages.splice(state.conversation.messages.length - 1, 1, assistant);
    if (state.conversation.title === 'New conversation') state.conversation.title = content.slice(0, 80);
    renderConversation();
    await refreshHistory();
    await refreshAnalytics();
  } catch (error) {
    state.conversation.messages.splice(state.conversation.messages.length - 2, 2);
    elements.messageInput.value = content;
    renderConversation();
    showToast(error.message);
  } finally {
    setComposerBusy(false);
    elements.messageInput.focus();
  }
}

const QUICK_LADDER_LEVELS = [1, 2, 4, 5, 6, 8, 10, 11, 12, 14, 16, 18, 20, 22, 28];
const QUICK_DEMO_LEVELS = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29];

function scenarioFilename(source) {
  if (source === 'scenarios15') return 'prompts-quick15.jsonl';
  if (source === 'scenarios10') return 'prompts-demo10.jsonl';
  return 'prompts-scenarios30.jsonl';
}

async function runLadder(mode) {
  if (state.ladderRunning) return;
  const useQuick = mode === 'quick';
  const scenarios = useQuick
    ? state.scenarios.filter((s) => QUICK_LADDER_LEVELS.includes(s.level))
    : state.scenarios;
  state.ladderRunning = true;
  state.ladderStopRequested = false;
  document.querySelectorAll('.mode-pill').forEach((btn) => { btn.disabled = true; btn.title = 'Cannot change mode while ladder is running'; });
  elements.runLadderButton.classList.add('running');
  elements.ladderProgress.hidden = false;
  if (elements.ladderStopButton) {
    elements.ladderStopButton.hidden = false;
    elements.ladderStopButton.disabled = false;
    elements.ladderStopButton.textContent = 'Stop';
  }
  if (elements.ladderBanner) elements.ladderBanner.hidden = false;
  if (elements.ladderBannerStop) {
    elements.ladderBannerStop.disabled = false;
    elements.ladderBannerStop.textContent = 'Stop';
  }
  elements.ladderHint.textContent = 'Routing each prompt as an isolated call…';
  setComposerBusy(true);
  const total = scenarios.length;
  const maxRetries = 2;
  const retryDelayMs = 1500;
  const perScenarioDelayMs = 500;
  const failed = [];
  let completed = 0;
  let stoppedEarly = false;
  try {
    const label = useQuick ? '15 quick' : `${state.scenarios.length} full`;
    const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: `Ladder · ${state.routingMode} · ${label} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }) });
    state.conversation = { ...created, messages: [] };
    await refreshHistory();
    renderConversation();
    switchTab('analytics');
    for (let index = 0; index < total; index += 1) {
      if (state.ladderStopRequested) { stoppedEarly = true; break; }
      const scenario = scenarios[index];
      if (index > 0) await new Promise((r) => setTimeout(r, perScenarioDelayMs));
      if (state.ladderStopRequested) { stoppedEarly = true; break; }
      const pending = { role: 'assistant', pending: true, pendingLabel: `Routing L${scenario.level} · ${scenario.title}…` };
      state.conversation.messages.push({ role: 'user', content: scenario.prompt, complexity_level: scenario.level }, pending);
      renderConversation();
      let assistant = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (state.ladderStopRequested) break;
        const suffix = attempt > 0 ? ` · retry ${attempt}/${maxRetries}` : '';
        elements.ladderProgressText.textContent = `${index + 1} / ${total} · L${scenario.level} ${scenario.title}${suffix}`;
        if (elements.ladderBannerText) elements.ladderBannerText.textContent = `Ladder ${index + 1} / ${total}${suffix}`;
        if (elements.ladderBannerHint) elements.ladderBannerHint.textContent = `L${scenario.level} · ${scenario.title}`;
        elements.ladderBarFill.style.width = `${(index / total) * 100}%`;
        if (attempt > 0) {
          pending.pendingLabel = `Retry ${attempt}/${maxRetries} · L${scenario.level}…`;
          renderConversation();
        }
        try {
          assistant = await sendPrompt(state.conversation.id, scenario.prompt, scenario.level, { noHistory: true });
          break;
        } catch (error) {
          if (attempt === maxRetries) {
            failed.push({ level: scenario.level, title: scenario.title, error: error.message });
            break;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        }
      }
      const lastIndex = state.conversation.messages.length - 1;
      if (assistant) {
        state.conversation.messages.splice(lastIndex, 1, assistant);
        completed += 1;
      } else {
        const reason = state.ladderStopRequested ? '⏹ Stopped by user.' : `⚠️ Skipped after ${maxRetries} retries. Continuing the ladder.`;
        state.conversation.messages.splice(lastIndex, 1, { role: 'assistant', content: reason, routed_model: state.ladderStopRequested ? 'stopped' : 'skipped', complexity_level: scenario.level });
      }
      renderConversation();
      await refreshAnalytics();
      if (state.ladderStopRequested) { stoppedEarly = true; break; }
    }
    elements.ladderBarFill.style.width = stoppedEarly ? `${(completed / total) * 100}%` : '100%';
    const summary = stoppedEarly
      ? `Stopped · ${completed} / ${total} complete · ${failed.length} skipped`
      : (failed.length ? `${completed} / ${total} complete · ${failed.length} skipped` : `${total} / ${total} · complete`);
    elements.ladderProgressText.textContent = summary;
    await refreshHistory();
    if (stoppedEarly) showToast(`Ladder stopped by you after ${completed} of ${total} scenarios.`);
    else showToast(failed.length ? `Ladder finished with ${failed.length} skipped scenario${failed.length === 1 ? '' : 's'} — see Logs tab for details.` : 'Ladder benchmark complete.');
  } catch (error) {
    showToast(`Ladder stopped: ${error.message}`);
  } finally {
    state.ladderRunning = false;
    state.ladderStopRequested = false;
    document.querySelectorAll('.mode-pill').forEach((btn) => { btn.disabled = false; btn.removeAttribute('title'); });
    elements.runLadderButton.classList.remove('running');
    setComposerBusy(false);
    if (elements.ladderStopButton) elements.ladderStopButton.hidden = true;
    if (elements.ladderBanner) elements.ladderBanner.hidden = true;
    elements.ladderHint.textContent = 'Auto-runs each level in a fresh conversation and fills analytics live.';
    setTimeout(() => { elements.ladderProgress.hidden = true; elements.ladderBarFill.style.width = '0%'; }, 6000);
  }
}

function selectScenario(level) {
  const scenario = state.scenarios.find((item) => item.level === Number(level));
  if (!scenario) return;
  elements.complexity.value = scenario.level;
  elements.complexityValue.textContent = `${scenario.level} / 10`;
  elements.messageInput.value = scenario.prompt;
  elements.messageInput.focus();
  if (window.innerWidth <= 1050) closeDrawers();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => { tab.classList.toggle('active', tab.dataset.tab === name); tab.setAttribute('aria-selected', tab.dataset.tab === name); });
  elements.scenariosTab.classList.toggle('hidden', name !== 'scenarios');
  elements.analyticsTab.classList.toggle('hidden', name !== 'analytics');
  if (elements.logsTab) elements.logsTab.classList.toggle('hidden', name !== 'logs');
  if (elements.evalTab) elements.evalTab.classList.toggle('hidden', name !== 'eval');
  if (name === 'eval') { refreshEvalCount(); refreshEvalDeployments(); refreshEvalToolkitDatasets(); }
}

function refreshEvalCount() {
  if (!elements.evalCount) return;
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let label = '';
  if (source === 'scenarios30') label = `${state.scenarios.length} scenarios (full 30).`;
  else if (source === 'scenarios15') label = `${QUICK_LADDER_LEVELS.length} scenarios (curated: levels ${QUICK_LADDER_LEVELS.join(', ')}).`;
  else if (source === 'scenarios10') label = `${QUICK_DEMO_LEVELS.length} scenarios (demo: mixed easy/medium/hard).`;
  else if (source.startsWith('toolkit:')) label = `Toolkit dataset: ${source.replace('toolkit:', '')}`;
  else if (source.startsWith('user:')) label = `Your dataset: ${source.replace('user:', '')}`;
  elements.evalCount.textContent = label;
  refreshEvalStatus();
}

async function refreshEvalToolkitDatasets() {
  const container = document.getElementById('evalToolkitDatasets');
  const userContainer = document.getElementById('evalUserDatasets');
  const samples = document.getElementById('evalByoSamples');
  try {
    const { datasets, userDatasets } = await api('/api/eval/toolkit-datasets');
    if (container) {
      if (!datasets?.length) container.innerHTML = '';
      else container.innerHTML = datasets.map((d) =>
        `<label class="radio-item"><input type="radio" name="evalSource" value="toolkit:${escapeHtml(d.name)}" data-path="${escapeHtml(d.path)}"> Toolkit — <code>${escapeHtml(d.name)}</code> <small>(bundled sample${d.promptCount != null ? ' · ' + d.promptCount + ' prompts' : ''})</small></label>`
      ).join('');
    }
    if (userContainer) {
      if (!userDatasets?.length) userContainer.innerHTML = '';
      else userContainer.innerHTML = userDatasets.map((d) =>
        `<label class="radio-item"><input type="radio" name="evalSource" value="user:${escapeHtml(d.name)}" data-path="${escapeHtml(d.path)}"> Your dataset — <code>${escapeHtml(d.name)}</code>${d.promptCount != null ? ` <small>(${d.promptCount} prompts)</small>` : ''}</label>`
      ).join('');
    }
    if (samples) {
      const items = (datasets || []).map((d) =>
        `<a href="/api/eval/dataset/download?name=${encodeURIComponent(d.name)}" download>${escapeHtml(d.name)}</a>`
      );
      samples.innerHTML = items.length
        ? `<span class="eval-hint">Download a sample to use as template:</span>${items.join('')}`
        : '<p class="eval-hint">Install the toolkit above to see downloadable sample templates.</p>';
    }
    document.querySelectorAll('input[name="evalSource"]').forEach((r) => {
      r.removeEventListener('change', refreshEvalCount);
      r.addEventListener('change', refreshEvalCount);
    });
  } catch {
    if (container) container.innerHTML = '';
    if (userContainer) userContainer.innerHTML = '';
  }
}

async function saveByoDataset() {
  const nameField = elements.evalByoName;
  const contentField = elements.evalByoContent;
  const fileField = elements.evalByoFile;
  let content = contentField?.value?.trim() || '';
  let name = (nameField?.value?.trim() || 'my-prompts.jsonl').replace(/[^\w.\-]/g, '_');
  if (!name.endsWith('.jsonl')) name += '.jsonl';
  if (!content && fileField?.files?.[0]) {
    const file = fileField.files[0];
    content = await file.text();
    if (!nameField?.value?.trim()) name = file.name.replace(/[^\w.\-]/g, '_');
  }
  if (!content) { showToast('Paste JSONL or choose a file first.'); return; }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!obj.prompt || typeof obj.prompt !== 'string') bad.push(`line ${i + 1}: missing prompt`);
    } catch { bad.push(`line ${i + 1}: invalid JSON`); }
  }
  if (bad.length) { showToast(`Validation failed: ${bad.slice(0, 3).join('; ')}`); return; }
  try {
    await api('/api/eval/dataset', { method: 'POST', body: JSON.stringify({ name, content: lines.join('\n') + '\n' }) });
    showToast(`Saved ${name} (${lines.length} prompts). Select it above.`);
    await refreshEvalToolkitDatasets();
    const radio = document.querySelector(`input[name="evalSource"][value="user:${name.replace(/"/g, '\\"')}"]`);
    if (radio) { radio.checked = true; refreshEvalCount(); }
  } catch (error) { showToast(error.message); }
}

async function run3ModeComparison() {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let datasetPath;
  if (source.startsWith('toolkit:') || source.startsWith('user:')) {
    const radio = document.querySelector(`input[name="evalSource"][value="${source.replace(/"/g, '\\"')}"]`);
    datasetPath = radio?.dataset.path;
    if (!datasetPath) { showToast('Could not resolve dataset path.'); return; }
  } else {
    const list = selectedScenarios();
    const content = list.map((s) => JSON.stringify({
      id: `scenario-${String(s.level).padStart(2, '0')}`,
      prompt: s.prompt,
      category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
      difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard',
      level: s.level,
      title: s.title
    })).join('\n') + '\n';
    const name = scenarioFilename(source);
    const written = await api('/api/eval/dataset', { method: 'POST', body: JSON.stringify({ name, content }) });
    datasetPath = written.path;
  }
  const baseline = elements.evalBaseline?.value?.trim();
  const judge = elements.evalJudge?.value?.trim();
  const balanced = (elements.evalMode3Balanced?.value?.trim() || state.deployments?.balanced || '').trim();
  const cost = (elements.evalMode3Cost?.value?.trim() || state.deployments?.cost || '').trim();
  const quality = (elements.evalMode3Quality?.value?.trim() || state.deployments?.quality || '').trim();
  const configured = [balanced, cost, quality].filter(Boolean);
  if (configured.length < 2) { showToast('Pick at least two of the router dropdowns below the button (or configure BALANCED/COST/QUALITY in .env).'); return; }
  if (!baseline) { showToast('Pick a baseline deployment above first.'); return; }
  const preview = `Baseline: ${baseline}\nBalanced: ${balanced || '(skip)'}\nCost: ${cost || '(skip)'}\nQuality: ${quality || '(skip)'}\n\nThis will run ${configured.length} sequential evaluations. Continue?`;
  if (!confirm(preview)) return;
  await api('/api/eval/run-3-modes', {
    method: 'POST',
    body: JSON.stringify({
      datasetPath,
      config: elements.evalConfig?.value,
      balancedDeployment: balanced || undefined,
      costDeployment: cost || undefined,
      qualityDeployment: quality || undefined,
      baselineDeployment: baseline,
      judgeDeployment: judge || undefined
    })
  });
  showToast('3-mode comparison started. Watch the console — takes ~3× longer than one run.');
}

async function runQuickBenchmark() {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let datasetPath;
  if (source.startsWith('toolkit:') || source.startsWith('user:')) {
    const radio = document.querySelector(`input[name="evalSource"][value="${source.replace(/"/g, '\\"')}"]`);
    datasetPath = radio?.dataset.path;
    if (!datasetPath) { showToast('Could not resolve dataset path.'); return; }
  } else {
    const list = selectedScenarios();
    const content = list.map((s) => JSON.stringify({
      id: `scenario-${String(s.level).padStart(2, '0')}`,
      prompt: s.prompt,
      category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
      difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard',
      level: s.level,
      title: s.title
    })).join('\n') + '\n';
    const name = scenarioFilename(source);
    const written = await api('/api/eval/dataset', { method: 'POST', body: JSON.stringify({ name, content }) });
    datasetPath = written.path;
  }
  const endpoints = [
    { label: 'Balanced', deployment: elements.benchBalanced?.value?.trim(), routingMode: 'balanced' },
    { label: 'Cost', deployment: elements.benchCost?.value?.trim(), routingMode: 'cost' },
    { label: 'Quality', deployment: elements.benchQuality?.value?.trim(), routingMode: 'quality' },
    { label: 'Baseline', deployment: elements.benchBaseline?.value?.trim(), routingMode: 'balanced' }
  ].filter((e) => e.deployment);
  if (endpoints.length < 2) { showToast('Pick at least two endpoints for the benchmark.'); return; }
  const preview = 'Quick benchmark will fire the dataset at:\n' + endpoints.map((e) => `  ${e.label}: ${e.deployment}`).join('\n') + '\n\nContinue?';
  if (!confirm(preview)) return;
  if (elements.benchStopButton) elements.benchStopButton.hidden = false;
  if (elements.benchOpenCompareButton) elements.benchOpenCompareButton.hidden = true;
  if (elements.benchRunButton) elements.benchRunButton.disabled = true;
  if (elements.benchProgress) elements.benchProgress.hidden = false;
  setBenchProgress(0, endpoints.length * 100, 'Starting…');
  state.benchmarkRunning = true;
  applyEvalLockout(false);
  try {
    await api('/api/benchmark/run', {
      method: 'POST',
      body: JSON.stringify({
        datasetPath,
        endpoints,
        concurrency: Number(elements.benchConcurrency?.value) || 2,
        requestDelayMs: Number(elements.benchDelayMs?.value) || 0
      })
    });
    showToast('Quick benchmark started — progress bar below.');
  } catch (error) {
    showToast(error.message);
    if (elements.benchRunButton) elements.benchRunButton.disabled = false;
    if (elements.benchStopButton) elements.benchStopButton.hidden = true;
    state.benchmarkRunning = false;
    applyEvalLockout(false);
  }
}

let benchmarkConversationIds = [];
let benchTotalPromptsExpected = 0;
function subscribeBenchmarkStream() {
  try {
    const source = new EventSource('/api/benchmark/stream');
    source.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        appendEvalLine(entry);
        updateBenchProgress(entry.line);
        if (entry.line?.includes('===== QUICK BENCHMARK complete') || entry.line?.includes('===== QUICK BENCHMARK stopped')) {
          if (elements.benchRunButton) elements.benchRunButton.disabled = false;
          if (elements.benchStopButton) elements.benchStopButton.hidden = true;
          if (elements.benchProgress) elements.benchProgress.hidden = true;
          state.benchmarkRunning = false;
          applyEvalLockout(false);
          setTimeout(async () => {
            await refreshHistory();
            const bench = state.conversations.filter((c) => (c.title || '').startsWith('[Bench '));
            const latestBatch = bench.slice(0, 4).map((c) => c.id);
            benchmarkConversationIds = latestBatch;
            if (elements.benchOpenCompareButton) {
              elements.benchOpenCompareButton.hidden = latestBatch.length < 2;
              elements.benchOpenCompareButton.dataset.conversationIds = latestBatch.join(',');
            }
            showToast(`Benchmark done. ${latestBatch.length} conversations created — open in Compare Dashboard.`);
          }, 500);
        }
      } catch { /* ignore */ }
    };
  } catch { /* ignore */ }
}

function updateBenchProgress(line) {
  if (!elements.benchProgress || !line) return;
  const totalMatch = line.match(/prompts:\s*(\d+)\s*·\s*endpoints:\s*(\d+)/);
  if (totalMatch) {
    benchTotalPromptsExpected = Number(totalMatch[1]) * Number(totalMatch[2]);
    elements.benchProgress.hidden = false;
    setBenchProgress(0, benchTotalPromptsExpected, 'Warming up…');
    return;
  }
  const endpointMatch = line.match(/^-+ Endpoint:\s*([^(]+)\(([^)]+)\)/);
  if (endpointMatch) {
    setBenchProgress(null, null, `Running ${endpointMatch[1].trim()} · ${endpointMatch[2].trim()}`);
    return;
  }
  const progMatch = line.match(/^\s+([A-Za-z]+):\s*(\d+)\/(\d+)\s*\((\d+)\s+ok,\s*(\d+)\s+err\)/);
  if (progMatch) {
    setBenchProgress(Number(progMatch[2]), Number(progMatch[3]), `${progMatch[1]} · ${progMatch[4]} ok · ${progMatch[5]} err`);
  }
}

function setBenchProgress(done, total, label) {
  if (label !== null && elements.benchProgressLabel) elements.benchProgressLabel.textContent = label;
  if (done !== null && total !== null && elements.benchProgressCount) {
    elements.benchProgressCount.textContent = `${done}/${total}`;
    const pct = total > 0 ? (done / total) * 100 : 0;
    if (elements.benchProgressFill) elements.benchProgressFill.style.width = `${pct}%`;
  }
}

function setEvalMode(mode) {
  document.querySelectorAll('.eval-mode-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.evalMode === mode));
  const quick = document.getElementById('evalModeQuick');
  const toolkit = document.getElementById('evalModeToolkit');
  if (quick) quick.hidden = mode !== 'quick';
  if (toolkit) toolkit.hidden = mode !== 'toolkit';
}

async function openCompareModalWithSelection(conversationIds) {
  const ids = [...new Set((conversationIds || []).filter(Boolean))].slice(0, MAX_COMPARE);
  if (ids.length < 2) { showToast('Need at least 2 conversations to open Compare.'); return; }
  // Make sure the sidebar list is fresh so titles/message_counts appear in the modal
  await refreshHistory();
  compareSelection.clear();
  for (const id of ids) compareSelection.add(id);
  elements.compareModal.hidden = false;
  elements.compareModalBody.innerHTML = '<p class="empty-analytics">Loading comparison…</p>';
  try {
    const results = await Promise.all(ids.map(async (id) => {
      const conversation = state.conversations.find((c) => c.id === id) || { id, title: 'Conversation', updated_at: new Date().toISOString(), message_count: 0 };
      const [analytics, full] = await Promise.all([
        api('/api/analytics?conversationId=' + encodeURIComponent(id)),
        api('/api/conversations/' + encodeURIComponent(id))
      ]);
      return { conversation, analytics, messages: full?.messages || [] };
    }));
    renderComparisonBody(results, 'dashboard');
  } catch (error) {
    elements.compareModalBody.innerHTML = '<p class="empty-analytics">Comparison failed: ' + escapeHtml(error.message) + '</p>';
  }
}

async function refreshEvalStatus() {
  if (!elements.evalStatus) return;
  try {
    const s = await api('/api/eval/status');
    const chips = [];
    chips.push(`<span class="chip ${s.toolkitInstalled ? 'ok' : 'missing'}">Toolkit: ${s.toolkitInstalled ? 'installed' : 'not installed'}</span>`);
    chips.push(`<span class="chip ${s.venvReady ? 'ok' : 'missing'}">venv: ${s.venvReady ? 'ready' : 'missing'}</span>`);
    chips.push(`<span class="chip ${s.envConfigured ? 'ok' : 'missing'}">toolkit .env: ${s.envConfigured ? 'written' : 'not written (auto-written on first Run)'}</span>`);
    chips.push(`<span class="chip ${s.apiKeyPresent ? 'ok' : 'ok'}">Auth: ${s.apiKeyPresent ? 'API key' : 'Entra ID (patched)'}</span>`);
    if (s.busy) chips.push('<span class="chip busy">busy</span>');
    elements.evalStatus.innerHTML = chips.join('');
    if (elements.evalInstallButton) {
      elements.evalInstallButton.disabled = s.busy;
      elements.evalInstallButton.textContent = s.toolkitInstalled ? 'Update toolkit (git pull)' : 'Install toolkit';
    }
    if (elements.evalRunButton) elements.evalRunButton.disabled = s.busy || !s.toolkitInstalled;
    if (elements.evalDryRunButton) elements.evalDryRunButton.disabled = s.busy || !s.toolkitInstalled;
    if (elements.evalStopButton) elements.evalStopButton.hidden = !s.busy;
    applyEvalLockout(s.busy);
    refreshEvalHistory();
    refreshBenchmarkHistory();
  } catch { /* ignore */ }
}

const BATCH_DEPLOY_TEMPLATE = [
  { key: 'balanced', kind: 'router', label: 'Balanced router', deploymentName: 'mr-balanced', mode: 'balanced', enabled: true },
  { key: 'cost', kind: 'router', label: 'Cost router', deploymentName: 'mr-cost', mode: 'cost', enabled: true },
  { key: 'quality', kind: 'router', label: 'Quality router', deploymentName: 'mr-quality', mode: 'quality', enabled: true },
  { key: 'baseline', kind: 'model', label: 'Baseline', deploymentName: 'gpt-5.2', modelName: 'gpt-5.2', modelVersion: '2025-12-11', enabled: true }
];

function renderBatchDeployList() {
  const el = document.getElementById('batchDeployList');
  if (!el) return;
  el.innerHTML = BATCH_DEPLOY_TEMPLATE.map((row) => `
    <div class="batch-row" data-key="${escapeHtml(row.key)}">
      <label class="batch-toggle"><input type="checkbox" data-field="enabled" ${row.enabled ? 'checked' : ''}> <span>${escapeHtml(row.label)}</span></label>
      <input type="text" class="batch-name" data-field="deploymentName" value="${escapeHtml(row.deploymentName)}" placeholder="deployment name">
      ${row.kind === 'router'
        ? `<select class="batch-mode" data-field="mode">
             <option value="balanced"${row.mode === 'balanced' ? ' selected' : ''}>balanced</option>
             <option value="cost"${row.mode === 'cost' ? ' selected' : ''}>cost</option>
             <option value="quality"${row.mode === 'quality' ? ' selected' : ''}>quality</option>
           </select>`
        : `<input type="text" class="batch-model" data-field="modelName" value="${escapeHtml(row.modelName)}" placeholder="model name" title="e.g. gpt-5.2">`}
      <span class="batch-status" data-status="idle">idle</span>
    </div>`).join('');
}

async function deployBatchFromUI() {
  const rows = document.querySelectorAll('.batch-row');
  const template = new Map(BATCH_DEPLOY_TEMPLATE.map((t) => [t.key, t]));
  const items = [];
  rows.forEach((rowEl) => {
    const key = rowEl.dataset.key;
    const tpl = template.get(key);
    const enabled = rowEl.querySelector('[data-field="enabled"]')?.checked;
    if (!enabled) return;
    const deploymentName = rowEl.querySelector('[data-field="deploymentName"]')?.value?.trim();
    if (!deploymentName) return;
    if (tpl.kind === 'router') {
      const mode = rowEl.querySelector('[data-field="mode"]')?.value;
      items.push({ key, kind: 'router', deploymentName, mode, capacity: 20, version: '2025-11-18' });
    } else {
      const modelName = rowEl.querySelector('[data-field="modelName"]')?.value?.trim() || tpl.modelName;
      items.push({ key, kind: 'model', deploymentName, modelName, modelVersion: tpl.modelVersion, sku: 'GlobalStandard', capacity: 1 });
    }
  });
  if (!items.length) { showToast('Tick at least one row.'); return; }
  const summary = items.map((i) => `  ${i.key}: ${i.deploymentName}` + (i.mode ? ` (mode=${i.mode})` : ` (${i.modelName})`)).join('\n');
  if (!confirm(`Deploy ${items.length} model(s) into your Foundry account?\n\n${summary}\n\nEach takes ~30s. Uses your Azure management-plane quota.`)) return;
  items.forEach((i) => setBatchRowStatus(i.key, 'queued'));
  if (elements.batchDeployButton) { elements.batchDeployButton.disabled = true; elements.batchDeployButton.textContent = 'Deploying…'; }
  try {
    await api('/api/eval/deploy-batch', { method: 'POST', body: JSON.stringify({ items }) });
    showToast('Batch deployment started — watch rows and eval console.');
  } catch (error) {
    showToast(error.message);
    if (elements.batchDeployButton) { elements.batchDeployButton.disabled = false; elements.batchDeployButton.textContent = 'Deploy selected'; }
  }
}

function setBatchRowStatus(key, state, error) {
  const cell = document.querySelector(`.batch-row[data-key="${key}"] .batch-status`);
  if (!cell) return;
  cell.dataset.status = state;
  cell.textContent = state === 'failed' && error ? `failed · ${error.slice(0, 40)}` : state;
  const stillActive = [...document.querySelectorAll('.batch-status')].some((s) => s.dataset.status === 'creating' || s.dataset.status === 'queued');
  if (!stillActive && elements.batchDeployButton) {
    elements.batchDeployButton.disabled = false;
    elements.batchDeployButton.textContent = 'Deploy selected';
    setTimeout(() => refreshEvalDeployments({ force: true }), 3000);
  }
}

async function refreshBenchmarkHistory() {
  if (!elements.benchHistory) return;
  try {
    const { runs } = await api('/api/benchmark/history');
    if (!runs?.length) { elements.benchHistory.innerHTML = '<p class="empty-analytics">No benchmarks run yet.</p>'; return; }
    elements.benchHistory.innerHTML = runs.map((r) => {
      const when = new Date(r.started_at).toLocaleString();
      const duration = r.completed_at ? Math.round((new Date(r.completed_at) - new Date(r.started_at)) / 1000) : null;
      let endpoints = [];
      try { endpoints = JSON.parse(r.endpoints_json || '[]'); } catch { /* ignore */ }
      let conversationIds = [];
      try { conversationIds = JSON.parse(r.conversation_ids_json || '[]'); } catch { /* ignore */ }
      const endpointsList = endpoints.map((e) => `<span class="chip">${escapeHtml(e.label)}: ${escapeHtml(e.deployment)}</span>`).join(' ');
      const canOpen = conversationIds.length >= 2 && r.status === 'success';
      return `<div class="eval-history-item ${escapeHtml(r.status)}">
        <div class="info">
          <strong>Bench ${escapeHtml(r.id.slice(0, 8))} · ${endpoints.length} endpoints · ${r.total_prompts || '?'} prompts</strong>
          <small>${escapeHtml(r.dataset_name || '-')} · ${when}${duration ? ` · ${duration}s` : ''}${r.error ? ' · ' + escapeHtml(r.error.slice(0, 80)) : ''}</small>
          <div class="eval-history-summary">${endpointsList}</div>
        </div>
        <button data-bench-ids="${escapeHtml(conversationIds.join(','))}" ${canOpen ? '' : 'disabled'}>${r.status === 'running' ? 'running…' : r.status === 'success' ? 'Open Compare' : escapeHtml(r.status)}</button>
      </div>`;
    }).join('');
    elements.benchHistory.querySelectorAll('button[data-bench-ids]:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ids = (btn.dataset.benchIds || '').split(',').filter(Boolean);
        if (!ids.length) { showToast('No conversations linked to this benchmark.'); return; }
        openCompareModalWithSelection(ids);
      });
    });
  } catch { /* ignore */ }
}

async function refreshEvalHistory() {
  if (!elements.evalHistory) return;
  try {
    const { runs } = await api('/api/eval/history');
    if (!runs?.length) { elements.evalHistory.innerHTML = '<p class="empty-analytics">No evaluations run yet.</p>'; return; }
    const batches = new Map();
    const singletons = [];
    for (const r of runs) {
      if (r.batch_id) {
        if (!batches.has(r.batch_id)) batches.set(r.batch_id, []);
        batches.get(r.batch_id).push(r);
      } else singletons.push(r);
    }
    const sections = [];
    const batchList = [...batches.entries()].sort((a, b) => new Date(b[1][0].started_at) - new Date(a[1][0].started_at));
    for (const [batchId, batchRuns] of batchList) {
      sections.push(renderBatch(batchId, batchRuns));
    }
    for (const r of singletons) sections.push(renderSingleRun(r));
    elements.evalHistory.innerHTML = sections.join('');
    elements.evalHistory.querySelectorAll('button[data-run-id]:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api('/api/eval/open-report', { method: 'POST', body: '{}' }); showToast('Opened dashboard'); }
        catch (error) { showToast(error.message); }
      });
    });
    elements.evalHistory.querySelectorAll('button[data-materialize-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.materializeId;
        if (!confirm('Save this evaluation as two conversations (Router + Baseline) with all prompts and responses? They will appear in your conversation list.')) return;
        btn.disabled = true; btn.textContent = 'saving…';
        try {
          await api('/api/eval/materialize', { method: 'POST', body: JSON.stringify({ runId }) });
          showToast('Eval saved as conversations. Open the chat sidebar to see them.');
          await refreshHistory();
        } catch (error) { showToast(error.message); btn.disabled = false; btn.textContent = 'Persist'; }
      });
    });
  } catch { /* ignore */ }
}

function renderSingleRun(r) {
  const when = new Date(r.started_at).toLocaleString();
  const duration = r.completed_at ? Math.round((new Date(r.completed_at) - new Date(r.started_at)) / 1000) : null;
  const title = `${escapeHtml(r.router_deployment || 'router')} vs ${escapeHtml(r.baseline_deployment || 'baseline')} · judge ${escapeHtml(r.judge_deployment || '-')}`;
  const meta = `${escapeHtml(r.dataset_name || '-')} · ${when}${duration ? ` · ${duration}s` : ''}`;
  const summaryChips = renderSummaryChips(r.summary_json);
  const canOpen = r.dashboard_path && r.status === 'success';
  const canMaterialize = r.status === 'success' && r.run_dir;
  return `<div class="eval-history-item ${escapeHtml(r.status)}">
    <div class="info"><strong>${title}</strong><small>${meta}${r.error ? ' · error: ' + escapeHtml(r.error.slice(0, 80)) : ''}</small>${summaryChips}</div>
    <div class="eval-history-actions">
      ${canMaterialize ? `<button data-materialize-id="${escapeHtml(r.id)}" title="Save router and baseline responses as browsable conversations">Persist</button>` : ''}
      <button data-run-id="${escapeHtml(r.id)}" ${canOpen ? '' : 'disabled'}>${r.status === 'running' ? 'running…' : r.status === 'success' ? 'Open' : 'Failed'}</button>
    </div>
  </div>`;
}

function renderBatch(batchId, batchRuns) {
  const first = batchRuns[0];
  const when = new Date(first.started_at).toLocaleString();
  const baseline = first.baseline_deployment || '-';
  const dataset = first.dataset_name || '-';
  const allDone = batchRuns.every((r) => r.status !== 'running');
  const anyFail = batchRuns.some((r) => r.status === 'failed');
  const overall = !allDone ? 'running' : anyFail ? 'failed' : 'success';
  const rows = batchRuns.map((r) => {
    const s = parseSummary(r.summary_json);
    const cells = [
      `<td><b>${escapeHtml(r.mode_label || '?')}</b><br><small>${escapeHtml(r.router_deployment || '')}</small></td>`,
      `<td><span class="chip ${r.status}">${escapeHtml(r.status)}</span></td>`,
      `<td>${s?.total ? `${s.routerSuccess ?? '?'}/${s.total}` : '—'}</td>`,
      `<td>${s?.routerLatencyP95 && s.routerLatencyP95 !== 'N/A' ? escapeHtml(s.routerLatencyP95) : '—'}</td>`,
      `<td>${s?.routerCost && s.routerCost !== 'N/A' ? escapeHtml(s.routerCost) : '—'}</td>`,
      `<td>${r.status === 'success' && r.dashboard_path ? `<button data-run-id="${escapeHtml(r.id)}">Open</button>` : '—'}</td>`
    ].join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<div class="eval-batch ${overall}">
    <div class="eval-batch-header">
      <div><strong>3-mode comparison</strong> · baseline <code>${escapeHtml(baseline)}</code><br><small>${escapeHtml(dataset)} · ${when} · batch ${escapeHtml(batchId.slice(0, 8))}</small></div>
      <span class="chip ${overall}">${overall}</span>
    </div>
    <table class="eval-batch-table"><thead><tr>
      <th>Mode</th><th>Status</th><th>OK/Total</th><th>Router p95</th><th>Router cost</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function parseSummary(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function renderSummaryChips(json) {
  const s = parseSummary(json);
  if (!s) return '';
  const chips = [];
  if (s.total) chips.push(`<span class="chip">${s.routerSuccess ?? '?'}/${s.total} router OK</span>`);
  if (s.routerErrors) chips.push(`<span class="chip missing">${s.routerErrors} router err</span>`);
  if (s.routerLatencyP95 && s.routerLatencyP95 !== 'N/A') chips.push(`<span class="chip">router p95: ${escapeHtml(s.routerLatencyP95)}</span>`);
  if (s.baselineLatencyP95 && s.baselineLatencyP95 !== 'N/A') chips.push(`<span class="chip">baseline p95: ${escapeHtml(s.baselineLatencyP95)}</span>`);
  if (s.routerCost && s.routerCost !== 'N/A') chips.push(`<span class="chip">router cost: ${escapeHtml(s.routerCost)}</span>`);
  if (s.baselineCost && s.baselineCost !== 'N/A') chips.push(`<span class="chip">baseline cost: ${escapeHtml(s.baselineCost)}</span>`);
  return chips.length ? `<div class="eval-history-summary">${chips.join('')}</div>` : '';
}

function applyEvalLockout(busy) {
  const locked = busy || state.benchmarkRunning;
  if (elements.evalLockout) elements.evalLockout.hidden = !locked;
  if (locked) {
    const title = elements.evalLockoutTitle;
    const msg = elements.evalLockoutMessage;
    if (state.benchmarkRunning) {
      if (title) title.textContent = 'Quick benchmark in progress';
      if (msg) msg.textContent = 'Chat is paused while the benchmark fires prompts at every endpoint. Watch the Evaluation tab → progress bar.';
    } else {
      if (title) title.textContent = 'Evaluation in progress';
      if (msg) msg.textContent = 'Chat is paused while the Auto-Evaluation toolkit is running. Watch the Evaluation tab → live console for progress.';
    }
  }
  document.querySelectorAll('.mode-pill').forEach((btn) => { if (btn) btn.disabled = locked || state.ladderRunning; });
  if (elements.runLadderButton) elements.runLadderButton.disabled = locked || state.ladderRunning;
  if (elements.runLadderQuickButton) elements.runLadderQuickButton.disabled = locked || state.ladderRunning;
  if (elements.messageInput) elements.messageInput.disabled = locked;
  if (elements.sendButton) elements.sendButton.disabled = locked;
  document.querySelectorAll('[data-conversation-new], .new-conversation, #newConversationButton').forEach((el) => { el.disabled = locked; });
}

let evalDeploymentsCache = null;
async function refreshEvalDeployments({ force = false } = {}) {
  if (!elements.evalBaseline || !elements.evalRecommend) return;
  try {
    if (!force && evalDeploymentsCache && Date.now() - evalDeploymentsCache.ts < 60_000) {
      // reuse cached response to avoid the ~5s az CLI round-trip on every tab switch
      return applyEvalDeployments(evalDeploymentsCache.data);
    }
    const data = await api('/api/eval/deployments');
    evalDeploymentsCache = { ts: Date.now(), data };
    return applyEvalDeployments(data);
  } catch (error) {
    elements.evalRecommend.innerHTML = `<p class="eval-hint">Could not list deployments: ${escapeHtml(error.message)}. Make sure you are signed in via <code>az login</code>.</p>`;
  }
}

function applyEvalDeployments({ deployments, recommended }) {
    const routerDeps = (deployments || []).filter((d) => (d.model || '').toLowerCase() === 'model-router');
    const nonRouter = (deployments || []).filter((d) => (d.model || '').toLowerCase() !== 'model-router');
    const routerOptions = ['<option value="">— use MODEL_ROUTER_DEPLOYMENT_BALANCED from .env —</option>']
      .concat(routerDeps.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} — model-router</option>`))
      .join('');
    const baselineOptions = ['<option value="">— pick a baseline model —</option>']
      .concat(nonRouter.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} — ${escapeHtml(d.model || 'unknown')}</option>`))
      .join('');
    const judgeOptions = ['<option value="">— pick a judge model —</option>']
      .concat(nonRouter.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} — ${escapeHtml(d.model || 'unknown')}</option>`))
      .join('');
    const rVal = elements.evalRouter?.value;
    const bVal = elements.evalBaseline.value;
    const jVal = elements.evalJudge.value;
    if (elements.evalRouter) { elements.evalRouter.innerHTML = routerOptions; elements.evalRouter.value = rVal; }
    elements.evalBaseline.innerHTML = baselineOptions;
    elements.evalJudge.innerHTML = judgeOptions;
    elements.evalBaseline.value = bVal;
    elements.evalJudge.value = jVal;
    for (const [id, envDefault] of [
      ['evalMode3Balanced', state.deployments?.balanced],
      ['evalMode3Cost', state.deployments?.cost],
      ['evalMode3Quality', state.deployments?.quality]
    ]) {
      const el = elements[id];
      if (!el) continue;
      const prev = el.value;
      const label = id.replace('evalMode3', '').toLowerCase();
      const opts = [`<option value="">— skip ${label} —</option>`]
        .concat(routerDeps.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}${d.name === envDefault ? ' (from .env)' : ''}</option>`))
        .join('');
      el.innerHTML = opts;
      el.value = prev || envDefault || '';
    }
    for (const [id, envDefault, label, includeBaseline] of [
      ['benchBalanced', state.deployments?.balanced, 'balanced', false],
      ['benchCost', state.deployments?.cost, 'cost', false],
      ['benchQuality', state.deployments?.quality, 'quality', false],
      ['benchBaseline', null, 'baseline', true]
    ]) {
      const el = elements[id];
      if (!el) continue;
      const prev = el.value;
      const opts = [`<option value="">— skip ${label} —</option>`]
        .concat((includeBaseline ? nonRouter : routerDeps).map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}${!includeBaseline && d.name === envDefault ? ' (from .env)' : includeBaseline ? ` — ${escapeHtml(d.model || 'unknown')}` : ''}</option>`))
        .join('');
      el.innerHTML = opts;
      el.value = prev || envDefault || '';
    }
    const existingNames = new Set((deployments || []).map((d) => d.name));
    elements.evalRecommend.innerHTML = (recommended || []).map((rec) => {
      const deployed = existingNames.has(rec.deploymentName);
      return `<div class="eval-rec-item ${deployed ? 'deployed' : ''}">
        <div class="rec-info">
          <strong>${escapeHtml(rec.deploymentName)} <span class="rec-badge ${rec.role}">${rec.role}</span></strong>
          <small>${escapeHtml(rec.modelName)} · v${escapeHtml(rec.modelVersion)} · ${escapeHtml(rec.note)}</small>
        </div>
        ${deployed
          ? '<button disabled>Already deployed</button>'
          : `<button data-deploy='${JSON.stringify(rec).replace(/'/g, '&apos;')}'>Deploy</button>`}
      </div>`;
    }).join('');
    elements.evalRecommend.querySelectorAll('button[data-deploy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rec = JSON.parse(btn.dataset.deploy.replace(/&apos;/g, "'"));
        if (!confirm(`Deploy ${rec.modelName} as "${rec.deploymentName}" in this Foundry resource? Deployment takes ~1 minute and uses your Azure quota.`)) return;
        try {
          await api('/api/eval/deploy', { method: 'POST', body: JSON.stringify(rec) });
          showToast(`Deploying ${rec.deploymentName}… watch the console.`);
        } catch (error) { showToast(error.message); }
      });
    });
}

function appendEvalLine(record) {
  if (!elements.evalConsole) return;
  if (elements.evalConsole.querySelector('.empty-analytics')) elements.evalConsole.innerHTML = '';
  const el = document.createElement('span');
  el.className = 'line' + (record.line.startsWith('$') ? ' cmd' : /error|traceback|failed/i.test(record.line) ? ' err' : '');
  el.textContent = record.line + '\n';
  elements.evalConsole.appendChild(el);
  elements.evalConsole.scrollTop = elements.evalConsole.scrollHeight;
  refreshEvalStatus();
}

function subscribeToEval() {
  if (!elements.evalConsole) return;
  try {
    const source = new EventSource('/api/eval/stream');
    source.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        appendEvalLine(entry);
        const statusMatch = entry.line?.match(/^__STATUS__ (.+)$/);
        if (statusMatch) {
          try { const s = JSON.parse(statusMatch[1]); if (s.key && s.state) setBatchRowStatus(s.key, s.state, s.error); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };
    source.onerror = () => { /* auto-reconnects */ };
  } catch { /* ignore */ }
}

async function runEvalDataset(dryRun) {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let datasetPath;
  if (source.startsWith('toolkit:') || source.startsWith('user:')) {
    const radio = document.querySelector(`input[name="evalSource"][value="${source.replace(/"/g, '\\"')}"]`);
    datasetPath = radio?.dataset.path;
    if (!datasetPath) { showToast('Could not resolve dataset path.'); return; }
  } else {
    const list = selectedScenarios();
    const content = list.map((s) => JSON.stringify({
      id: `scenario-${String(s.level).padStart(2, '0')}`,
      prompt: s.prompt,
      category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
      difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard',
      level: s.level,
      title: s.title
    })).join('\n') + '\n';
    const name = scenarioFilename(source);
    const written = await api('/api/eval/dataset', { method: 'POST', body: JSON.stringify({ name, content }) });
    datasetPath = written.path;
  }
  const baseline = elements.evalBaseline?.value?.trim();
  const judge = elements.evalJudge?.value?.trim();
  const routerName = state.deployments?.balanced || state.deployments?.[state.routingMode] || '';
  if (baseline && baseline === routerName) {
    if (!confirm(`Baseline "${baseline}" is the same as your router deployment. This produces a router-vs-router comparison that will show zero difference. Continue anyway?`)) return;
  }
  await api('/api/eval/configure', {
    method: 'POST',
    body: JSON.stringify({
      routerDeployment: elements.evalRouter?.value?.trim() || undefined,
      baselineDeployment: baseline || undefined,
      judgeDeployment: judge || undefined
    })
  });
  await api('/api/eval/run', {
    method: 'POST',
    body: JSON.stringify({
      datasetPath,
      config: elements.evalConfig?.value,
      dryRun,
      routerDeployment: elements.evalRouter?.value?.trim() || undefined,
      baselineDeployment: baseline || undefined,
      judgeDeployment: judge || undefined
    })
  });
  showToast(dryRun ? 'Dry run started.' : 'Live evaluation started.');
}

function buildJsonlLine(entry) {
  return JSON.stringify(entry) + '\n';
}

function selectedScenarios() {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  if (source === 'scenarios15') return state.scenarios.filter((s) => QUICK_LADDER_LEVELS.includes(s.level));
  if (source === 'scenarios10') return state.scenarios.filter((s) => QUICK_DEMO_LEVELS.includes(s.level));
  if (source === 'scenarios30') return state.scenarios;
  return null;
}

function scenariosToJsonl(list) {
  return list.map((s) => buildJsonlLine({
    id: `scenario-${String(s.level).padStart(2, '0')}`,
    prompt: s.prompt,
    category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
    difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard', level: s.level, title: s.title,
    metadata: { level: s.level, title: s.title }
  })).join('');
}

function exportJsonl() {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  if (source.startsWith('toolkit:') || source.startsWith('user:')) {
    const name = source.split(':', 2)[1];
    window.open(`/api/eval/dataset/download?name=${encodeURIComponent(name)}`, '_blank');
    return;
  }
  const list = selectedScenarios();
  const name = scenarioFilename(source);
  downloadFile(name, scenariosToJsonl(list));
  showToast(`Exported ${list.length} scenarios.`);
}

function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const logEntries = [];
function renderLogEntry(entry) {
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const source = entry.source || 'chat';
  const srcBadge = `<span class="log-source src-${escapeHtml(source)}">${escapeHtml(source)}</span>`;
  const ctxLine = entry.context ? ` <span class="log-ctx">${escapeHtml(entry.context.endpointLabel || '')}${entry.context.batchId ? ' · batch ' + escapeHtml(entry.context.batchId) : ''}${entry.context.promptId ? ' · ' + escapeHtml(entry.context.promptId) : ''}</span>` : '';
  if (entry.kind === 'request') {
    return `<div class="log-entry req"><div class="log-head"><span>${srcBadge} ${time} · REQUEST${ctxLine}</span><span>${escapeHtml(entry.auth)}</span></div><div class="log-body">${escapeHtml(entry.method)} ${escapeHtml(entry.url)}</div><div class="log-meta"><span>deployment: ${escapeHtml(entry.deployment)}</span><span>${entry.messageCount} msg${entry.messageCount === 1 ? '' : 's'}</span></div></div>`;
  }
  if (entry.kind === 'response') {
    const cls = entry.ok ? 'res-ok' : 'res-err';
    const modelLine = entry.ok ? `<span>routed: <b>${escapeHtml(entry.routedModel || 'unknown')}</b></span><span>tokens: ${entry.totalTokens}</span>` : `<span>error: ${escapeHtml(entry.error || '')}</span>`;
    return `<div class="log-entry ${cls}"><div class="log-head"><span>${srcBadge} ${time} · RESPONSE ${entry.status}${ctxLine}</span><span>${entry.latencyMs} ms</span></div><div class="log-body">${entry.requestId ? `request-id: ${escapeHtml(entry.requestId)}` : ''}</div><div class="log-meta">${modelLine}</div></div>`;
  }
  return `<div class="log-entry err"><div class="log-head"><span>${srcBadge} ${time} · NETWORK ERROR${ctxLine}</span><span>${entry.latencyMs || 0} ms</span></div><div class="log-body">${escapeHtml(entry.error || '')}</div></div>`;
}
function renderLogs() {
  if (!elements.logsList) return;
  elements.logsCount.textContent = `${logEntries.length} event${logEntries.length === 1 ? '' : 's'}`;
  elements.logsList.innerHTML = logEntries.length ? logEntries.slice().reverse().map(renderLogEntry).join('') : '<p class="empty-analytics">Waiting for the first Foundry call…</p>';
}

const compareSelection = new Set();
const MAX_COMPARE = 4;

function openComparePicker() {
  compareSelection.clear();
  renderComparePicker();
  elements.compareModal.hidden = false;
}

function renderComparePicker() {
  const list = state.conversations.filter((c) => c.message_count > 0);
  if (!list.length) {
    elements.compareModalBody.innerHTML = '<p class="empty-analytics">No conversations with data yet. Run at least one scenario or the ladder first.</p>';
    return;
  }
  elements.compareModalBody.innerHTML =
    '<div class="compare-actions"><span class="count" id="compareCount">' + compareSelection.size + ' / ' + MAX_COMPARE + ' selected · pick 2 to ' + MAX_COMPARE + '</span><button type="button" id="compareClear">Clear</button><button type="button" id="compareShow"' + (compareSelection.size < 2 ? ' disabled' : '') + '>Show comparison</button></div>' +
    '<div class="compare-picker">' + list.map((c) => {
      const isChecked = compareSelection.has(c.id);
      return `
      <label class="compare-pick ${isChecked ? 'selected' : ''}" data-id="${escapeHtml(c.id)}">
        <input type="checkbox" data-id="${escapeHtml(c.id)}"${isChecked ? ' checked' : ''}>
        <div style="flex:1"><strong>${escapeHtml(c.title || 'Untitled')}</strong><small>${c.message_count} messages · ${new Date(c.updated_at).toLocaleString()}</small></div>
      </label>`;
    }).join('') + '</div>';
  const showBtn = document.getElementById('compareShow');
  const clearBtn = document.getElementById('compareClear');
  const countEl = document.getElementById('compareCount');
  elements.compareModalBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        if (compareSelection.size >= MAX_COMPARE) { cb.checked = false; showToast(`Max ${MAX_COMPARE} conversations. Uncheck one first.`); return; }
        compareSelection.add(id);
      } else {
        compareSelection.delete(id);
      }
      cb.closest('.compare-pick').classList.toggle('selected', cb.checked);
      countEl.textContent = `${compareSelection.size} / ${MAX_COMPARE} selected · pick 2 to ${MAX_COMPARE}`;
      showBtn.disabled = compareSelection.size < 2;
    });
  });
  clearBtn.addEventListener('click', () => { compareSelection.clear(); renderComparePicker(); });
  showBtn.addEventListener('click', renderComparison);
}

async function renderComparison() {
  const ids = [...compareSelection];
  elements.compareModalBody.innerHTML = '<p class="empty-analytics">Loading comparison…</p>';
  try {
    const results = await Promise.all(ids.map(async (id) => {
      const conversation = state.conversations.find((c) => c.id === id);
      const [analytics, full] = await Promise.all([
        api('/api/analytics?conversationId=' + encodeURIComponent(id)),
        api('/api/conversations/' + encodeURIComponent(id))
      ]);
      return { conversation, analytics, messages: full?.messages || [] };
    }));
    renderComparisonBody(results, 'dashboard');
  } catch (error) {
    elements.compareModalBody.innerHTML = '<p class="empty-analytics">Comparison failed: ' + escapeHtml(error.message) + '</p>';
  }
}

function renderComparisonBody(results, view) {
  const body = view === 'dashboard'
    ? renderComparisonDashboard(results)
    : view === 'columns'
      ? '<div class="compare-grid">' + results.map(renderComparisonColumn).join('') + '</div>'
      : renderComparisonTable(results);
  elements.compareModalBody.innerHTML =
    '<div class="compare-actions"><span class="count">Comparing ' + results.length + ' conversations</span>' +
    '<div class="compare-view-toggle">' +
      '<button type="button" id="compareViewDash" class="' + (view === 'dashboard' ? 'active' : '') + '">Dashboard</button>' +
      '<button type="button" id="compareViewTable" class="' + (view === 'table' ? 'active' : '') + '">Per-question table</button>' +
      '<button type="button" id="compareViewCols" class="' + (view === 'columns' ? 'active' : '') + '">Side-by-side</button>' +
    '</div>' +
    '<button type="button" id="compareBack">← Back to picker</button></div>' +
    body;
  document.getElementById('compareBack').addEventListener('click', renderComparePicker);
  document.getElementById('compareViewDash').addEventListener('click', () => renderComparisonBody(results, 'dashboard'));
  document.getElementById('compareViewTable').addEventListener('click', () => renderComparisonBody(results, 'table'));
  document.getElementById('compareViewCols').addEventListener('click', () => renderComparisonBody(results, 'columns'));
  elements.compareModalBody.querySelectorAll('[data-toggle-cost]').forEach((el) => {
    el.addEventListener('click', () => {
      const details = el.closest('.compare-dash-card')?.querySelector('.cost-breakdown-detail');
      if (!details) return;
      details.open = !details.open;
      if (details.open) details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

async function populateJudgeDropdown() {
  const sel = document.getElementById('compareJudge');
  const btn = document.getElementById('compareScoreButton');
  if (!sel) return;
  try {
    const { deployments } = await api('/api/eval/deployments');
    const opts = (deployments || []).filter((d) => (d.model || '').toLowerCase() !== 'model-router')
      .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} — ${escapeHtml(d.model || 'unknown')}</option>`).join('');
    sel.innerHTML = '<option value="">— pick a judge deployment —</option>' + opts;
    sel.addEventListener('change', () => { btn.disabled = !sel.value; });
  } catch (error) {
    sel.innerHTML = '<option value="">Could not load deployments (need az login)</option>';
  }
}

async function scoreAllConversations(results) {
  const sel = document.getElementById('compareJudge');
  const btn = document.getElementById('compareScoreButton');
  const status = document.getElementById('compareJudgeStatus');
  const judge = sel?.value;
  if (!judge) return;
  btn.disabled = true;
  const original = btn.textContent;
  try {
    for (let i = 0; i < results.length; i += 1) {
      const conv = results[i].conversation;
      status.textContent = `Scoring conversation ${i + 1}/${results.length} (${conv.title})…`;
      await api(`/api/conversations/${conv.id}/score`, { method: 'POST', body: JSON.stringify({ judgeDeployment: judge }) });
    }
    status.textContent = 'Refreshing analytics…';
    const refreshed = await Promise.all(results.map(async (r) => {
      const analytics = await api('/api/analytics?conversationId=' + encodeURIComponent(r.conversation.id));
      return { conversation: r.conversation, analytics };
    }));
    status.innerHTML = '<span style="color:var(--green)">✓ Scoring complete.</span>';
    const currentView = document.getElementById('compareViewDash')?.classList.contains('active') ? 'dashboard'
      : document.getElementById('compareViewTable')?.classList.contains('active') ? 'table' : 'columns';
    renderComparisonBody(refreshed, currentView);
  } catch (error) {
    status.innerHTML = '<span style="color:#c9302c">Failed: ' + escapeHtml(error.message) + '</span>';
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderComparisonDashboard(results) {
  if (!results.length) return '<p class="empty-analytics">No conversations selected.</p>';
  const cheapest = results.reduce((min, r) => r.analytics.summary.actual_cost < min.analytics.summary.actual_cost ? r : min, results[0]);
  const fastest = results.reduce((min, r) => r.analytics.summary.avg_latency_ms < min.analytics.summary.avg_latency_ms ? r : min, results[0]);
  const qualityScored = results.some((r) => r.analytics.complexity.some((row) => row.avg_accuracy != null));
  const bestQuality = qualityScored ? results.reduce((best, r) => averageQuality(r) > averageQuality(best) ? r : best, results[0]) : null;

  const explainer = `
    <details class="compare-dash-explainer" open>
      <summary>How to read this dashboard</summary>
      <p>Same idea as the evaluation dashboard, but for <b>conversations you've already had</b>. Each column below is one conversation.
      Bars compare them side-by-side so you can see which conversation was cheaper, faster, or scored better.</p>
      <ul>
        <li><b>Cost</b> — actual USD spent on that conversation (based on tokens × per-model pricing).</li>
        <li><b>Savings vs baseline</b> — how much cheaper than sending every message to <code>${escapeHtml(results[0].analytics.summary.baseline_model || 'baseline')}</code>. Positive = router saved money.</li>
        <li><b>Avg latency</b> — average response time in ms. Lower is better.</li>
        <li><b>Quality</b> — only appears after you click <b>Score all</b>. Judge rates each response 1-5 on accuracy and helpfulness.</li>
      </ul>
    </details>`;

  const kpiCards = results.map((r) => renderConversationKpiCard(r, { cheapest, fastest, bestQuality, qualityScored })).join('');
  const charts = renderComparisonCharts(results, qualityScored);
  return `
    <div class="compare-dashboard">
      ${explainer}
      <div class="compare-dash-kpis">${kpiCards}</div>
      ${charts}
    </div>`;
}

function averageQuality(result) {
  const rows = result.analytics.complexity.filter((r) => r.avg_accuracy != null || r.avg_helpfulness != null);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, r) => acc + ((Number(r.avg_accuracy) || 0) + (Number(r.avg_helpfulness) || 0)) / 2, 0);
  return sum / rows.length;
}

function renderConversationKpiCard(result, { cheapest, fastest, bestQuality, qualityScored }) {
  const s = result.analytics.summary;
  const cheapBadge = result === cheapest ? '<span class="dash-badge win">cheapest</span>' : '';
  const fastBadge = result === fastest ? '<span class="dash-badge win">fastest</span>' : '';
  const qualBadge = bestQuality && result === bestQuality ? '<span class="dash-badge win">highest quality</span>' : '';
  const q = qualityScored ? averageQuality(result) : null;
  return `
    <div class="compare-dash-card">
      <div class="compare-dash-card-header">
        <div class="dash-title">${escapeHtml(result.conversation.title)}</div>
        <div class="dash-badges">${cheapBadge}${fastBadge}${qualBadge}${s.failed > 0 ? `<span class="dash-badge fail">${s.failed} failed</span>` : ''}</div>
      </div>
      <div class="compare-dash-kpi-row">
        <div class="compare-dash-kpi"><span class="lbl">Responses</span><span class="val">${s.responses}${s.failed > 0 ? ` <span class="failed-inline" title="${s.failed} request${s.failed === 1 ? '' : 's'} failed">/ ${s.failed} failed</span>` : ''}</span></div>
        <div class="compare-dash-kpi"><span class="lbl">Models used</span><span class="val">${s.models}</span></div>
        <div class="compare-dash-kpi has-detail" data-toggle-cost="1" title="Click to see how this cost was calculated"><span class="lbl">Cost <span class="info-dot">ⓘ</span></span><span class="val">$${(s.actual_cost || 0).toFixed(4)}</span><span class="sub">baseline $${(s.baseline_cost || 0).toFixed(4)}</span></div>
        <div class="compare-dash-kpi"><span class="lbl">Savings</span><span class="val ${s.savings_pct >= 0 ? 'pos' : 'neg'}">${s.savings_pct >= 0 ? '+' : ''}${(s.savings_pct || 0).toFixed(1)}%</span></div>
        <div class="compare-dash-kpi"><span class="lbl">Avg latency</span><span class="val">${s.avg_latency_ms} ms</span></div>
        <div class="compare-dash-kpi"><span class="lbl">Tokens</span><span class="val">${s.total_tokens.toLocaleString()}</span></div>
        ${q !== null ? `<div class="compare-dash-kpi"><span class="lbl">Avg quality</span><span class="val">${q.toFixed(2)}/5</span></div>` : ''}
      </div>
      <details class="cost-breakdown-detail">
        <summary>Show cost calculation</summary>
        ${renderCostBreakdown(result)}
      </details>
    </div>`;
}

function renderCostBreakdown(result) {
  const s = result.analytics.summary;
  const models = result.analytics.models || [];
  if (!models.length) return '<p class="empty-analytics">No response data yet.</p>';
  const rows = models.map((m) => `
    <div class="cost-row">
      <div class="cost-row-model">
        <strong>${escapeHtml(m.model || 'unknown')}</strong>
        <span class="tier tier-${escapeHtml(m.tier || '')}">${escapeHtml(m.tier || '')}</span>
      </div>
      <div class="cost-row-meta">
        <span class="cost-meta-calls">×${m.responses}</span>
        <span class="cost-meta-tokens"><span class="tok-in" title="Input tokens">↑${(m.prompt_tokens || 0).toLocaleString()}</span> <span class="tok-out" title="Output tokens">↓${(m.completion_tokens || 0).toLocaleString()}</span></span>
      </div>
      <div class="cost-row-total">${formatCost(m.cost || 0)}</div>
    </div>`).join('');
  return `
    <div class="cost-breakdown-body">
      <div class="cost-list">${rows}</div>
      <div class="cost-summary">
        <div class="cost-summary-row"><span>Total (routed)</span><strong>${formatCost(s.actual_cost || 0)}</strong></div>
        <div class="cost-summary-row muted"><span>If all on <code>${escapeHtml(s.baseline_model || BASELINE_MODEL)}</code></span><span>${formatCost(s.baseline_cost || 0)}</span></div>
        <div class="cost-summary-row saved"><span>Saved</span><strong class="${(s.savings || 0) >= 0 ? 'pos' : 'neg'}">${formatCost(s.savings || 0)} (${(s.savings_pct >= 0 ? '+' : '') + (s.savings_pct || 0).toFixed(1)}%)</strong></div>
      </div>
      <small>cost = (input × input_rate + output × output_rate) ÷ 1M · rates from <a href="https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/" target="_blank" rel="noopener">Azure Foundry Models pricing</a> (OpenAI, Anthropic, xAI, DeepSeek, Meta tabs)</small>
    </div>`;
}

function renderComparisonCharts(results, qualityScored) {
  const labels = results.map((r) => r.conversation.title);
  const costs = results.map((r) => Number(r.analytics.summary.actual_cost) || 0);
  const latencies = results.map((r) => Number(r.analytics.summary.avg_latency_ms) || 0);
  const savings = results.map((r) => Number(r.analytics.summary.savings_pct) || 0);
  const charts = [
    { title: 'Cost per conversation (USD)', values: costs, format: (v) => `$${v.toFixed(4)}`, colorFor: (v) => v === Math.min(...costs) ? 'var(--green)' : 'var(--accent)' },
    { title: 'Avg latency (ms) — lower is better', values: latencies, format: (v) => `${Math.round(v)} ms`, colorFor: (v) => v === Math.min(...latencies) ? 'var(--green)' : 'var(--accent)' },
    { title: 'Savings vs baseline (%) — higher is better', values: savings, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, colorFor: (v) => v >= 0 ? 'var(--green)' : '#d9534f' }
  ];
  if (qualityScored) {
    const quality = results.map(averageQuality);
    charts.push({ title: 'Avg quality score (1-5) — higher is better', values: quality, format: (v) => v.toFixed(2), colorFor: (v) => v === Math.max(...quality) ? 'var(--green)' : 'var(--accent)', max: 5 });
  }
  return `
    <div class="compare-dash-charts">
      ${charts.map((c) => renderBarChart(labels, c)).join('')}
      ${renderModelDistributionChart(results)}
    </div>`;
}

function renderBarChart(labels, { title, values, format, colorFor, max }) {
  const peak = max ?? Math.max(...values.map(Math.abs), 0.001);
  const rows = labels.map((label, i) => {
    const v = values[i];
    const pct = Math.max(2, Math.min(100, (Math.abs(v) / peak) * 100));
    return `
      <div class="bar-row">
        <div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label.slice(0, 32))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${colorFor(v)}"></div></div>
        <div class="bar-value">${format(v)}</div>
      </div>`;
  }).join('');
  return `<div class="compare-chart"><h4>${escapeHtml(title)}</h4>${rows}</div>`;
}

function renderModelDistributionChart(results) {
  const allModels = new Set();
  results.forEach((r) => r.analytics.models.forEach((m) => allModels.add(m.model)));
  if (!allModels.size) return '';
  const models = [...allModels];
  const palette = ['#0078d4', '#2e7d32', '#7c3aed', '#ea580c', '#0891b2', '#be185d', '#4b5563'];
  const rows = results.map((r) => {
    const total = r.analytics.models.reduce((sum, m) => sum + m.responses, 0) || 1;
    const segments = models.map((m, i) => {
      const found = r.analytics.models.find((x) => x.model === m);
      const pct = found ? (found.responses / total) * 100 : 0;
      if (!pct) return '';
      return `<div class="stack-seg" title="${escapeHtml(m)}: ${found.responses} responses (${pct.toFixed(0)}%)" style="width:${pct}%;background:${palette[i % palette.length]}">${pct >= 12 ? escapeHtml(m) : ''}</div>`;
    }).join('');
    return `
      <div class="stack-row">
        <div class="bar-label" title="${escapeHtml(r.conversation.title)}">${escapeHtml(r.conversation.title.slice(0, 32))}</div>
        <div class="stack-track">${segments}</div>
      </div>`;
  }).join('');
  const legend = models.map((m, i) => `<span class="legend-item"><span class="dot" style="background:${palette[i % palette.length]}"></span>${escapeHtml(m)}</span>`).join('');
  return `<div class="compare-chart"><h4>Model distribution — which model answered each response</h4>${rows}<div class="legend">${legend}</div></div>`;
}

function renderComparisonTable(results) {
  const isLadder = (title) => /ladder/i.test(title || '');
  const byLevel = new Map();
  const failedByLevelByConv = new Map();
  const ladderLevels = new Set();
  results.forEach(({ conversation, analytics }) => {
    analytics.complexity.forEach((row) => {
      if (!byLevel.has(row.level)) byLevel.set(row.level, {});
      const cell = byLevel.get(row.level);
      if (!cell[conversation.id]) cell[conversation.id] = [];
      cell[conversation.id].push(row);
      if (isLadder(conversation.title)) ladderLevels.add(row.level);
    });
    (analytics.failedByLevel || []).forEach((f) => {
      if (!failedByLevelByConv.has(f.level)) failedByLevelByConv.set(f.level, {});
      failedByLevelByConv.get(f.level)[conversation.id] = f;
    });
  });
  const allLevels = [...new Set([...byLevel.keys(), ...failedByLevelByConv.keys()])].sort((a, b) => a - b);
  allLevels.forEach((lvl) => { if (!byLevel.has(lvl)) byLevel.set(lvl, {}); });
  // For benchmark conversations, always show the actual user prompt as the question label — no lookup, no fallback logic.
  const anyBench = results.some(({ conversation }) => /^\[Bench /i.test(conversation.title || ''));
  const titleByLevel = new Map(anyBench ? [] : state.scenarios.map((s) => [s.level, s.title]));
  results.forEach(({ messages }) => {
    (messages || []).forEach((m) => {
      if (m.role === 'user' && m.complexity_level != null && !titleByLevel.has(m.complexity_level)) {
        const prompt = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (prompt) titleByLevel.set(m.complexity_level, prompt);
      }
    });
  });
  if (!allLevels.length) return '<p class="empty-analytics">No complexity data in the selected conversations.</p>';
  const buildRow = (level, idx) => `
    <tr>
      <td class="lvl">${idx + 1}</td>
      <td class="q">${escapeHtml(titleByLevel.get(level) || '(custom prompt)')}</td>
      ${results.map((r) => {
        const items = (byLevel.get(level) || {})[r.conversation.id] || [];
        const failed = (failedByLevelByConv.get(level) || {})[r.conversation.id];
        if (!items.length && !failed) return '<td class="empty">—</td>';
        const cells = items.map((row) => {
          const quality = (row.avg_accuracy != null || row.avg_helpfulness != null)
            ? `<div class="cell-quality">Q: acc ${row.avg_accuracy ?? '–'}/5 · help ${row.avg_helpfulness ?? '–'}/5</div>`
            : '';
          return `
          <div class="cell-model"><strong>${escapeHtml(row.model)}</strong> <span class="tier tier-${row.tier}">${row.tier}</span></div>
          <small class="cell-meta">${row.avg_tokens} tok · ${row.avg_latency_ms} ms</small>
          ${quality}
        `;
        });
        if (failed && failed.failed > 0) {
          const errSnippet = escapeHtml((failed.error_samples || '').split(' | ')[0].replace(/^\[error\]\s*/, '').slice(0, 120));
          cells.push(`<div class="cell-failed" title="${errSnippet}"><strong>✗ Failed</strong>${failed.failed > 1 ? ` ×${failed.failed}` : ''}<br><small>${errSnippet || 'request failed'}</small></div>`);
        }
        return '<td class="' + (cells.length && failed && !items.length ? 'failed-only' : '') + '">' + cells.join('<hr>') + '</td>';
      }).join('')}
    </tr>`;
  const primaryRows = allLevels.map(buildRow).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">
    <thead>
      <tr>
        <th rowspan="2">#</th>
        <th rowspan="2">Question</th>
        ${results.map((r) => `<th><div>${escapeHtml(r.conversation.title)}</div><small>${new Date(r.conversation.updated_at).toLocaleString()}</small></th>`).join('')}
      </tr>
      <tr class="mode-row">
        ${results.map((r) => {
          const mode = detectMode(r.conversation.title);
          return `<th><span class="mode-badge mode-${mode.toLowerCase()}">${escapeHtml(mode)}</span></th>`;
        }).join('')}
      </tr>
    </thead>
    <tbody>${primaryRows}</tbody>
  </table></div>`;
}

function detectMode(title) {
  const m = String(title || '').toLowerCase();
  if (m.includes('balanced')) return 'Balanced';
  if (m.includes('quality')) return 'Quality';
  if (m.includes('cost')) return 'Cost';
  return 'Custom';
}

function renderComparisonColumn({ conversation, analytics }) {
  const s = analytics.summary;
  const maxResponses = Math.max(1, ...analytics.models.map((m) => m.responses));
  const modelRows = analytics.models.length ? analytics.models.map((m) => `
    <div class="model-row">
      <div class="model-label"><span>${escapeHtml(m.model)} <span class="tier tier-${m.tier}">${m.tier}</span></span><span>${m.responses} · ${formatCost(m.cost || 0)}</span></div>
      <div class="model-bar tier-bg-${m.tier}"><span style="width:${Math.max(8, (m.responses / maxResponses) * 100)}%"></span></div>
    </div>`).join('') : '<p class="empty-analytics">No responses.</p>';
  const trailRows = analytics.complexity.length ? analytics.complexity.map((row) => `
    <div class="trail-row">
      <span class="trail-level">${row.level}</span>
      <span><strong>${escapeHtml(row.model)}</strong> <span class="tier tier-${row.tier}">${row.tier}</span></span>
      <span>${row.share_pct}% · ${row.avg_tokens} tok · ${row.avg_latency_ms} ms</span>
    </div>`).join('') : '<p class="empty-analytics">No trail.</p>';
  return `<section class="compare-col">
    <p class="eyebrow">${escapeHtml(new Date(conversation.updated_at).toLocaleString())}</p>
    <h3>${escapeHtml(conversation.title || 'Untitled')}</h3>
    <div style="margin-bottom:10px"><span class="mode-badge mode-${detectMode(conversation.title).toLowerCase()}">${escapeHtml(detectMode(conversation.title))}</span></div>
    <div class="metric-row"><span>Responses</span><strong>${s.responses}</strong></div>
    <div class="metric-row"><span>Models used</span><strong>${s.models}</strong></div>
    <div class="metric-row"><span>Total tokens</span><strong>${Number(s.total_tokens).toLocaleString()}</strong></div>
    <div class="metric-row"><span>Avg latency</span><strong>${s.avg_latency_ms} ms</strong></div>
    <div class="metric-row"><span>Actual cost</span><strong>${formatCost(s.actual_cost)}</strong></div>
    <div class="metric-row"><span>Baseline (${escapeHtml(s.baseline_model || 'gpt-5')})</span><strong>${formatCost(s.baseline_cost)}</strong></div>
    <div class="metric-row"><span>Saved</span><strong>${formatCost(Math.max(0, s.savings))} (${(s.savings_pct || 0).toFixed(0)}%)</strong></div>
    <h4>Model distribution</h4>
    <div class="model-chart">${modelRows}</div>
    <h4>Complexity trail</h4>
    <div class="complexity-trail">${trailRows}</div>
  </section>`;
}

function subscribeToLogs() {
  if (!elements.logsList) return;
  try {
    const source = new EventSource('/api/logs/stream');
    source.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        logEntries.push(entry);
        if (logEntries.length > 200) logEntries.shift();
        renderLogs();
      } catch { /* ignore */ }
    };
    source.onerror = () => { /* auto-reconnects */ };
  } catch { /* ignore */ }
}

function wireModeSelector() {
  if (!elements.modeSelector) return;
  const buttons = elements.modeSelector.querySelectorAll('.mode-pill');
  const fallback = state.deployments.balanced || state.deployments.cost || state.deployments.quality;
  const distinctModes = new Set([state.deployments.balanced, state.deployments.cost, state.deployments.quality].filter(Boolean));
  const singleDeployment = distinctModes.size <= 1;
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.routingMode = btn.dataset.mode;
      buttons.forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', b === btn ? 'true' : 'false'); });
      refreshModeBanner();
    });
  });
  refreshModeBanner(singleDeployment, fallback);
}

function refreshModeBanner(forceSingle, fallback) {
  if (!elements.modeBanner) return;
  const deployment = state.deployments[state.routingMode];
  const balanced = state.deployments.balanced;
  const cost = state.deployments.cost;
  const quality = state.deployments.quality;
  const distinct = new Set([balanced, cost, quality].filter(Boolean));
  const isSingle = forceSingle ?? distinct.size <= 1;
  if (state.provider !== 'foundry') { elements.modeBanner.hidden = true; return; }
  if (isSingle) {
    elements.modeBanner.hidden = false;
    elements.modeBanner.innerHTML = `You have one deployment configured (<b>${escapeHtml(deployment || fallback || 'unknown')}</b>). All three modes will hit the same deployment. To see real Balanced/Cost/Quality differences, create three deployments in Foundry with different routing modes and set <code>MODEL_ROUTER_DEPLOYMENT_BALANCED</code>, <code>_COST</code>, and <code>_QUALITY</code> in .env.`;
  } else {
    elements.modeBanner.hidden = false;
    elements.modeBanner.innerHTML = `Current mode: <b>${escapeHtml(state.routingMode)}</b> → deployment <b>${escapeHtml(deployment || 'not configured')}</b>. Switch pills above to route to a different deployment.`;
  }
}

function closeDrawers() {
  elements.historyPanel.classList.remove('open');
  elements.inspectorPanel.classList.remove('open');
  elements.scrim.classList.remove('open');
}

async function copyFromMeta(button) {
  const messageContent = button.closest('.message-body')?.querySelector('.message-content')?.textContent;
  if (!messageContent) return;
  try {
    await navigator.clipboard.writeText(messageContent);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  } catch { showToast('Copy blocked by the browser'); }
}

elements.newChatButton.addEventListener('click', createConversation);
elements.setupLaunchButton?.addEventListener('click', async () => {
  if (!confirm('Launch the setup wizard? It opens in a new tab at localhost:3100 so you can pick endpoint, deployments, and auth. You will need to restart RouteLab after saving the new .env.')) return;
  try {
    const { port, alreadyRunning } = await api('/api/setup/launch', { method: 'POST', body: '{}' });
    showToast(alreadyRunning ? 'Setup wizard already running.' : 'Setup wizard started.');
    window.open(`http://localhost:${port}/`, '_blank', 'noopener');
  } catch (error) { showToast('Could not launch setup: ' + error.message); }
});
elements.messageForm.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(); });
elements.messageInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
elements.complexity.addEventListener('input', () => { elements.complexityValue.textContent = `${elements.complexity.value} / 10`; });
elements.startScenarioButton.addEventListener('click', () => { elements.inspectorPanel.classList.add('open'); elements.scrim.classList.add('open'); });
elements.runLadderButton.addEventListener('click', () => runLadder('full'));
elements.runLadderQuickButton?.addEventListener('click', () => runLadder('quick'));
elements.ladderStopButton?.addEventListener('click', () => {
  if (!state.ladderRunning) return;
  state.ladderStopRequested = true;
  elements.ladderStopButton.disabled = true;
  elements.ladderStopButton.textContent = 'Stopping…';
});
elements.ladderBannerStop?.addEventListener('click', () => {
  if (!state.ladderRunning) return;
  state.ladderStopRequested = true;
  elements.ladderBannerStop.disabled = true;
  elements.ladderBannerStop.textContent = 'Stopping…';
  if (elements.ladderStopButton) elements.ladderStopButton.disabled = true;
});
elements.scenarioList.addEventListener('click', (event) => selectScenario(event.target.closest('[data-scenario]')?.dataset.scenario));
elements.historyList.addEventListener('click', (event) => {
  const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
  if (deleteId) { event.stopPropagation(); deleteConversation(deleteId); return; }
  const id = event.target.closest('[data-conversation]')?.dataset.conversation;
  if (id) openConversation(id);
});
elements.messages.addEventListener('click', (event) => {
  const copyBtn = event.target.closest('[data-copy]');
  if (copyBtn) return copyFromMeta(copyBtn);
  const costBtn = event.target.closest('[data-cost-toggle]');
  if (costBtn) {
    const breakdown = costBtn.closest('.message-body')?.querySelector('.cost-breakdown');
    if (breakdown) breakdown.hidden = !breakdown.hidden;
  }
});
document.querySelector('.inspector-tabs').addEventListener('click', (event) => { if (event.target.dataset.tab) switchTab(event.target.dataset.tab); });
elements.menuButton.addEventListener('click', () => { elements.historyPanel.classList.add('open'); elements.scrim.classList.add('open'); });
elements.inspectorButton.addEventListener('click', () => { elements.inspectorPanel.classList.add('open'); elements.scrim.classList.add('open'); });
elements.closeInspector.addEventListener('click', closeDrawers);
elements.scrim.addEventListener('click', closeDrawers);

try {
  const [config, scenariosData, conversations, analytics] = await Promise.all([
    api('/api/config'), api('/api/scenarios'), api('/api/conversations'), api('/api/analytics')
  ]);
  Object.assign(state, { provider: config.provider, scenarios: scenariosData, conversations, analytics, deployments: config.deployments || {} });
  const isFoundry = state.provider === 'foundry';
  elements.providerName.textContent = isFoundry ? 'Foundry router' : 'Mock router';
  elements.providerHint.textContent = isFoundry ? 'Checking endpoint…' : 'Ready without an endpoint';
  elements.headerProvider.textContent = isFoundry ? 'LIVE FOUNDRY' : 'SIMULATION';
  renderHistory(); renderScenarios(); renderAnalytics(); renderConversation();
  wireModeSelector();
  if (isFoundry) { refreshEvalDeployments().catch(() => {}); refreshFoundryHealth(); }
  else applyFoundryHealth({ ok: null });
  elements.logsClear?.addEventListener('click', () => { logEntries.length = 0; renderLogs(); });
  elements.clearAllButton?.addEventListener('click', async () => {
    if (!confirm('Delete all conversations and analytics? This cannot be undone.')) return;
    try {
      await api('/api/data', { method: 'DELETE' });
      window.location.reload();
    } catch (error) { showToast(error.message); }
  });
  elements.compareButton?.addEventListener('click', openComparePicker);
  elements.compareClose?.addEventListener('click', () => { elements.compareModal.hidden = true; });
  elements.compareModal?.addEventListener('click', (event) => { if (event.target === elements.compareModal) elements.compareModal.hidden = true; });
  elements.evalExportButton?.addEventListener('click', exportJsonl);
  elements.evalInstallButton?.addEventListener('click', async () => {
    try { await api('/api/eval/install', { method: 'POST', body: '{}' }); showToast('Toolkit install started.'); refreshEvalStatus(); }
    catch (error) { showToast(error.message); }
  });
  elements.evalRunButton?.addEventListener('click', () => runEvalDataset(false).catch((e) => showToast(e.message)));
  elements.evalDryRunButton?.addEventListener('click', () => runEvalDataset(true).catch((e) => showToast(e.message)));
  elements.evalOpenReportButton?.addEventListener('click', async () => {
    try { const r = await api('/api/eval/open-report', { method: 'POST', body: '{}' }); showToast('Opened ' + r.path); }
    catch (error) { showToast(error.message); }
  });
  elements.evalRefreshDeploymentsButton?.addEventListener('click', () => refreshEvalDeployments({ force: true }));
  renderBatchDeployList();
  elements.batchDeployRefresh?.addEventListener('click', renderBatchDeployList);
  elements.batchDeployButton?.addEventListener('click', deployBatchFromUI);
  const stopEval = async () => {
    if (!confirm('Stop the running evaluation? Partial results will remain in the run folder.')) return;
    try { await api('/api/eval/stop', { method: 'POST', body: '{}' }); showToast('Stop requested.'); }
    catch (error) { showToast(error.message); }
  };
  elements.evalStopButton?.addEventListener('click', stopEval);
  elements.evalLockoutStop?.addEventListener('click', async () => {
    if (state.benchmarkRunning) {
      if (!confirm('Stop the benchmark? Prompts already in flight will finish.')) return;
      try { await api('/api/benchmark/stop', { method: 'POST', body: '{}' }); showToast('Stop requested.'); }
      catch (error) { showToast(error.message); }
      return;
    }
    stopEval();
  });
  elements.evalByoSaveButton?.addEventListener('click', saveByoDataset);
  elements.evalRun3ModesButton?.addEventListener('click', run3ModeComparison);
  elements.benchRunButton?.addEventListener('click', runQuickBenchmark);
  document.querySelectorAll('.eval-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setEvalMode(btn.dataset.evalMode));
  });
  elements.benchStopButton?.addEventListener('click', async () => {
    if (!confirm('Stop the benchmark? Prompts already in flight will finish.')) return;
    try { await api('/api/benchmark/stop', { method: 'POST', body: '{}' }); showToast('Stop requested.'); }
    catch (error) { showToast(error.message); }
  });
  elements.benchOpenCompareButton?.addEventListener('click', () => {
    const ids = elements.benchOpenCompareButton?.dataset.conversationIds?.split(',').filter(Boolean) || [];
    if (!ids.length) { showToast('No benchmark conversations to compare yet.'); return; }
    switchTab('analytics');
    if (typeof openCompareModalWithSelection === 'function') openCompareModalWithSelection(ids);
    else showToast('Open the Analytics tab and click Compare to see them.');
  });
  subscribeBenchmarkStream();
  elements.evalLockoutJump?.addEventListener('click', () => {
    switchTab('eval');
    elements.inspectorPanel?.classList.add('open');
    elements.scrim?.classList.add('open');
  });
  document.querySelectorAll('input[name="evalSource"]').forEach((r) => r.addEventListener('change', refreshEvalCount));
  subscribeToEval();
  refreshEvalStatus();
  renderLogs();
  subscribeToLogs();
} catch (error) { showToast(error.message); }



