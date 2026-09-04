import { tierFor, calculateCost, BASELINE_MODEL, priceFor } from '/pricing.js';

const state = { conversations: [], conversation: null, scenarios: [], provider: 'mock', analytics: null, ladderRunning: false, ladderStopRequested: false, routingMode: 'balanced', deployments: {} };
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
        <small>${conversation.message_count} turns · ${escapeHtml(conversation.last_model || 'No model yet')}</small>
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
  const cost = calculateCost(message.routed_model, message.prompt_tokens || 0, message.completion_tokens || 0);
  const price = priceFor(message.routed_model);
  const inputTokens = message.prompt_tokens || 0;
  const outputTokens = message.completion_tokens || 0;
  const inputCost = (inputTokens * price.input) / 1_000_000;
  const outputCost = (outputTokens * price.output) / 1_000_000;
  const costTooltip = [
    `Model: ${message.routed_model || 'unknown'}`,
    `Input:  ${inputTokens} tokens × $${price.input.toFixed(2)} per 1M = ${formatCost(inputCost)}`,
    `Output: ${outputTokens} tokens × $${price.output.toFixed(2)} per 1M = ${formatCost(outputCost)}`,
    `Total:  ${formatCost(cost)}`,
    `Rates defined in public/pricing.js`
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
          <tr><td>Input</td><td>${inputTokens} tokens × $${price.input.toFixed(2)} per 1M tokens</td><td>= ${formatCost(inputCost)}</td></tr>
          <tr><td>Output</td><td>${outputTokens} tokens × $${price.output.toFixed(2)} per 1M tokens</td><td>= ${formatCost(outputCost)}</td></tr>
          <tr class="total"><td>Total</td><td></td><td>= ${formatCost(cost)}</td></tr>
        </table>
        <small>Formula: <code>(input_tokens × input_rate + output_tokens × output_rate) ÷ 1,000,000</code>. Rates defined in <code>public/pricing.js</code>.</small>
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
  state.conversation = { ...(await api('/api/conversations', { method: 'POST', body: '{}' })), messages: [] };
  await refreshHistory();
  renderConversation();
  closeDrawers();
  await refreshAnalytics();
  elements.messageInput.focus();
}

async function openConversation(id) {
  state.conversation = await api(`/api/conversations/${id}`);
  renderHistory();
  renderConversation();
  closeDrawers();
  await refreshAnalytics();
}

async function deleteConversation(id) {
  await api(`/api/conversations/${id}`, { method: 'DELETE' });
  if (state.conversation?.id === id) state.conversation = null;
  await refreshHistory();
  renderConversation();
  await refreshAnalytics();
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
  if (name === 'eval') { refreshEvalCount(); refreshEvalDeployments(); }
}

function refreshEvalCount() {
  if (!elements.evalCount) return;
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let label = '';
  if (source === 'scenarios30') label = `${state.scenarios.length} scenarios (full 30).`;
  else if (source === 'scenarios15') label = `${QUICK_LADDER_LEVELS.length} scenarios (curated: levels ${QUICK_LADDER_LEVELS.join(', ')}).`;
  else if (source.startsWith('toolkit:')) label = `Toolkit dataset: ${source.replace('toolkit:', '')}`;
  elements.evalCount.textContent = label;
  refreshEvalStatus();
  refreshEvalToolkitDatasets();
}

async function refreshEvalToolkitDatasets() {
  const container = document.getElementById('evalToolkitDatasets');
  if (!container) return;
  try {
    const { datasets } = await api('/api/eval/toolkit-datasets');
    if (!datasets?.length) { container.innerHTML = ''; return; }
    container.innerHTML = datasets.map((d) =>
      `<label class="radio-item"><input type="radio" name="evalSource" value="toolkit:${escapeHtml(d.name)}" data-path="${escapeHtml(d.path)}"> Toolkit — <code>${escapeHtml(d.name)}</code> <small>(bundled)</small></label>`
    ).join('');
    container.querySelectorAll('input[type="radio"]').forEach((r) => r.addEventListener('change', refreshEvalCount));
  } catch { container.innerHTML = ''; }
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
  } catch { /* ignore */ }
}

async function refreshEvalHistory() {
  if (!elements.evalHistory) return;
  try {
    const { runs } = await api('/api/eval/history');
    if (!runs?.length) { elements.evalHistory.innerHTML = '<p class="empty-analytics">No evaluations run yet.</p>'; return; }
    elements.evalHistory.innerHTML = runs.map((r) => {
      const when = new Date(r.started_at).toLocaleString();
      const duration = r.completed_at ? Math.round((new Date(r.completed_at) - new Date(r.started_at)) / 1000) : null;
      const title = `${escapeHtml(r.router_deployment || 'router')} vs ${escapeHtml(r.baseline_deployment || 'baseline')} · judge ${escapeHtml(r.judge_deployment || '-')}`;
      const meta = `${escapeHtml(r.dataset_name || '-')} · ${when}${duration ? ` · ${duration}s` : ''}`;
      let summaryChips = '';
      if (r.summary_json) {
        try {
          const s = JSON.parse(r.summary_json);
          const chips = [];
          if (s.total) chips.push(`<span class="chip">${s.routerSuccess ?? '?'}/${s.total} router OK</span>`);
          if (s.routerErrors) chips.push(`<span class="chip missing">${s.routerErrors} router err</span>`);
          if (s.routerLatencyP95 && s.routerLatencyP95 !== 'N/A') chips.push(`<span class="chip">router p95: ${escapeHtml(s.routerLatencyP95)}</span>`);
          if (s.baselineLatencyP95 && s.baselineLatencyP95 !== 'N/A') chips.push(`<span class="chip">baseline p95: ${escapeHtml(s.baselineLatencyP95)}</span>`);
          if (s.routerCost && s.routerCost !== 'N/A') chips.push(`<span class="chip">router cost: ${escapeHtml(s.routerCost)}</span>`);
          if (s.baselineCost && s.baselineCost !== 'N/A') chips.push(`<span class="chip">baseline cost: ${escapeHtml(s.baselineCost)}</span>`);
          if (chips.length) summaryChips = `<div class="eval-history-summary">${chips.join('')}</div>`;
        } catch { /* ignore */ }
      }
      const canOpen = r.dashboard_path && r.status === 'success';
      return `<div class="eval-history-item ${escapeHtml(r.status)}">
        <div class="info"><strong>${title}</strong><small>${meta}${r.error ? ' · error: ' + escapeHtml(r.error.slice(0, 80)) : ''}</small>${summaryChips}</div>
        <button data-run-id="${escapeHtml(r.id)}" ${canOpen ? '' : 'disabled'}>${r.status === 'running' ? 'running…' : r.status === 'success' ? 'Open' : 'Failed'}</button>
      </div>`;
    }).join('');
    elements.evalHistory.querySelectorAll('button[data-run-id]:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api('/api/eval/open-report', { method: 'POST', body: '{}' }); showToast('Opened dashboard'); }
        catch (error) { showToast(error.message); }
      });
    });
  } catch { /* ignore */ }
}

function applyEvalLockout(busy) {
  if (elements.evalLockout) elements.evalLockout.hidden = !busy;
  document.querySelectorAll('.mode-pill').forEach((btn) => { if (btn) btn.disabled = busy || state.ladderRunning; });
  if (elements.runLadderButton) elements.runLadderButton.disabled = busy || state.ladderRunning;
  if (elements.runLadderQuickButton) elements.runLadderQuickButton.disabled = busy || state.ladderRunning;
  if (elements.messageInput) elements.messageInput.disabled = busy;
  if (elements.sendButton) elements.sendButton.disabled = busy;
  document.querySelectorAll('[data-conversation-new], .new-conversation, #newConversationButton').forEach((el) => { el.disabled = busy; });
}

async function refreshEvalDeployments() {
  if (!elements.evalBaseline || !elements.evalRecommend) return;
  try {
    const { deployments, recommended } = await api('/api/eval/deployments');
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
  } catch (error) {
    elements.evalRecommend.innerHTML = `<p class="eval-hint">Could not list deployments: ${escapeHtml(error.message)}. Make sure you are signed in via <code>az login</code>.</p>`;
  }
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
    source.onmessage = (ev) => { try { appendEvalLine(JSON.parse(ev.data)); } catch { /* ignore */ } };
    source.onerror = () => { /* auto-reconnects */ };
  } catch { /* ignore */ }
}

async function runEvalDataset(dryRun) {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  let datasetPath;
  if (source.startsWith('toolkit:')) {
    const radio = document.querySelector(`input[name="evalSource"][value="${source.replace(/"/g, '\\"')}"]`);
    datasetPath = radio?.dataset.path;
    if (!datasetPath) { showToast('Could not resolve toolkit dataset path.'); return; }
  } else {
    const list = selectedScenarios();
    const content = list.map((s) => JSON.stringify({
      id: `scenario-${String(s.level).padStart(2, '0')}`,
      prompt: s.prompt,
      category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
      difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard'
    })).join('\n') + '\n';
    const name = source === 'scenarios15' ? 'prompts-quick15.jsonl' : 'prompts-scenarios30.jsonl';
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
  if (source === 'scenarios30') return state.scenarios;
  return null;
}

function scenariosToJsonl(list) {
  return list.map((s) => buildJsonlLine({
    id: `scenario-${String(s.level).padStart(2, '0')}`,
    prompt: s.prompt,
    category: String(s.category || '').toLowerCase().split(' · ')[0].replace(/\s+/g, '_') || 'general',
    difficulty: s.level <= 5 ? 'easy' : s.level <= 11 ? 'medium' : 'hard',
    metadata: { level: s.level, title: s.title }
  })).join('');
}

function exportJsonl() {
  const source = document.querySelector('input[name="evalSource"]:checked')?.value || 'scenarios30';
  if (source.startsWith('toolkit:')) {
    showToast('Toolkit datasets already live at eval-toolkit/datasets/. No export needed.');
    return;
  }
  const list = selectedScenarios();
  const name = source === 'scenarios15' ? 'prompts-quick15.jsonl' : 'prompts-scenarios30.jsonl';
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
  if (entry.kind === 'request') {
    return `<div class="log-entry req"><div class="log-head"><span>${time} · REQUEST</span><span>${escapeHtml(entry.auth)}</span></div><div class="log-body">${escapeHtml(entry.method)} ${escapeHtml(entry.url)}</div><div class="log-meta"><span>deployment: ${escapeHtml(entry.deployment)}</span><span>${entry.messageCount} msg${entry.messageCount === 1 ? '' : 's'}</span></div></div>`;
  }
  if (entry.kind === 'response') {
    const cls = entry.ok ? 'res-ok' : 'res-err';
    const modelLine = entry.ok ? `<span>routed: <b>${escapeHtml(entry.routedModel || 'unknown')}</b></span><span>tokens: ${entry.totalTokens}</span>` : `<span>error: ${escapeHtml(entry.error || '')}</span>`;
    return `<div class="log-entry ${cls}"><div class="log-head"><span>${time} · RESPONSE ${entry.status}</span><span>${entry.latencyMs} ms</span></div><div class="log-body">${entry.requestId ? `request-id: ${escapeHtml(entry.requestId)}` : ''}</div><div class="log-meta">${modelLine}</div></div>`;
  }
  return `<div class="log-entry err"><div class="log-head"><span>${time} · NETWORK ERROR</span><span>${entry.latencyMs || 0} ms</span></div><div class="log-body">${escapeHtml(entry.error || '')}</div></div>`;
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
    '<div class="compare-actions"><span class="count" id="compareCount">0 / ' + MAX_COMPARE + ' selected · pick 2 to ' + MAX_COMPARE + '</span><button type="button" id="compareShow" disabled>Show comparison</button></div>' +
    '<div class="compare-picker">' + list.map((c) => `
      <label class="compare-pick" data-id="${escapeHtml(c.id)}">
        <input type="checkbox" data-id="${escapeHtml(c.id)}">
        <div style="flex:1"><strong>${escapeHtml(c.title || 'Untitled')}</strong><small>${c.message_count} messages · ${new Date(c.updated_at).toLocaleString()}</small></div>
      </label>`).join('') + '</div>';
  const showBtn = document.getElementById('compareShow');
  const countEl = document.getElementById('compareCount');
  elements.compareModalBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        if (compareSelection.size >= MAX_COMPARE) { cb.checked = false; return; }
        compareSelection.add(id);
      } else {
        compareSelection.delete(id);
      }
      cb.closest('.compare-pick').classList.toggle('selected', cb.checked);
      countEl.textContent = `${compareSelection.size} / ${MAX_COMPARE} selected · pick 2 to ${MAX_COMPARE}`;
      showBtn.disabled = compareSelection.size < 2;
    });
  });
  showBtn.addEventListener('click', renderComparison);
}

async function renderComparison() {
  const ids = [...compareSelection];
  elements.compareModalBody.innerHTML = '<p class="empty-analytics">Loading comparison…</p>';
  try {
    const results = await Promise.all(ids.map(async (id) => {
      const conversation = state.conversations.find((c) => c.id === id);
      const analytics = await api('/api/analytics?conversationId=' + encodeURIComponent(id));
      return { conversation, analytics };
    }));
    renderComparisonBody(results, 'table');
  } catch (error) {
    elements.compareModalBody.innerHTML = '<p class="empty-analytics">Comparison failed: ' + escapeHtml(error.message) + '</p>';
  }
}

function renderComparisonBody(results, view) {
  const body = view === 'columns'
    ? '<div class="compare-grid">' + results.map(renderComparisonColumn).join('') + '</div>'
    : renderComparisonTable(results);
  const judgeSection =
    '<div class="compare-judge">' +
      '<label>Score responses with a judge (uses Entra auth, no API key needed):</label>' +
      '<select id="compareJudge"><option value="">— pick a judge deployment —</option></select>' +
      '<button type="button" id="compareScoreButton" disabled>Score all</button>' +
      '<span class="compare-judge-status" id="compareJudgeStatus"></span>' +
    '</div>';
  elements.compareModalBody.innerHTML =
    '<div class="compare-actions"><span class="count">Comparing ' + results.length + ' conversations</span>' +
    '<div class="compare-view-toggle">' +
      '<button type="button" id="compareViewTable" class="' + (view === 'table' ? 'active' : '') + '">Per-question table</button>' +
      '<button type="button" id="compareViewCols" class="' + (view === 'columns' ? 'active' : '') + '">Side-by-side</button>' +
    '</div>' +
    '<button type="button" id="compareBack">← Back to picker</button></div>' +
    judgeSection +
    body;
  document.getElementById('compareBack').addEventListener('click', renderComparePicker);
  document.getElementById('compareViewTable').addEventListener('click', () => renderComparisonBody(results, 'table'));
  document.getElementById('compareViewCols').addEventListener('click', () => renderComparisonBody(results, 'columns'));
  populateJudgeDropdown();
  document.getElementById('compareScoreButton').addEventListener('click', () => scoreAllConversations(results));
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
    renderComparisonBody(refreshed, document.getElementById('compareViewTable')?.classList.contains('active') ? 'table' : 'columns');
  } catch (error) {
    status.innerHTML = '<span style="color:#c9302c">Failed: ' + escapeHtml(error.message) + '</span>';
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderComparisonTable(results) {
  const isLadder = (title) => /ladder/i.test(title || '');
  const byLevel = new Map();
  const ladderLevels = new Set();
  results.forEach(({ conversation, analytics }) => {
    analytics.complexity.forEach((row) => {
      if (!byLevel.has(row.level)) byLevel.set(row.level, {});
      const cell = byLevel.get(row.level);
      if (!cell[conversation.id]) cell[conversation.id] = [];
      cell[conversation.id].push(row);
      if (isLadder(conversation.title)) ladderLevels.add(row.level);
    });
  });
  const allLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const primary = allLevels.filter((l) => ladderLevels.has(l));
  const secondary = allLevels.filter((l) => !ladderLevels.has(l));
  const titleByLevel = new Map(state.scenarios.map((s) => [s.level, s.title]));
  if (!allLevels.length) return '<p class="empty-analytics">No complexity data in the selected conversations.</p>';
  const buildRow = (level) => `
    <tr>
      <td class="lvl">L${level}</td>
      <td class="q">${escapeHtml(titleByLevel.get(level) || '(custom prompt)')}</td>
      ${results.map((r) => {
        const items = (byLevel.get(level) || {})[r.conversation.id] || [];
        if (!items.length) return '<td class="empty">—</td>';
        return '<td>' + items.map((row) => {
          const quality = (row.avg_accuracy != null || row.avg_helpfulness != null)
            ? `<div class="cell-quality">Q: acc ${row.avg_accuracy ?? '–'}/5 · help ${row.avg_helpfulness ?? '–'}/5</div>`
            : '';
          return `
          <div class="cell-model"><strong>${escapeHtml(row.model)}</strong> <span class="tier tier-${row.tier}">${row.tier}</span></div>
          <small class="cell-meta">${row.avg_tokens} tok · ${row.avg_latency_ms} ms</small>
          ${quality}
        `;
        }).join('<hr>') + '</td>';
      }).join('')}
    </tr>`;
  const primaryRows = primary.map(buildRow).join('');
  const divider = secondary.length
    ? `<tr class="section-divider"><td colspan="${2 + results.length}">Manual / non-ladder questions · not part of the mode comparison</td></tr>`
    : '';
  const secondaryRows = secondary.map(buildRow).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">
    <thead>
      <tr>
        <th rowspan="2">Level</th>
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
    <tbody>${primaryRows}${divider}${secondaryRows}</tbody>
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
  elements.providerHint.textContent = isFoundry ? 'Live endpoint connected' : 'Ready without an endpoint';
  elements.headerProvider.textContent = isFoundry ? 'LIVE FOUNDRY' : 'SIMULATION';
  renderHistory(); renderScenarios(); renderAnalytics(); renderConversation();
  wireModeSelector();
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
  elements.evalRefreshDeploymentsButton?.addEventListener('click', refreshEvalDeployments);
  const stopEval = async () => {
    if (!confirm('Stop the running evaluation? Partial results will remain in the run folder.')) return;
    try { await api('/api/eval/stop', { method: 'POST', body: '{}' }); showToast('Stop requested.'); }
    catch (error) { showToast(error.message); }
  };
  elements.evalStopButton?.addEventListener('click', stopEval);
  elements.evalLockoutStop?.addEventListener('click', stopEval);
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
