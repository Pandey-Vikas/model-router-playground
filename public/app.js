import { tierFor, calculateCost, BASELINE_MODEL } from '/pricing.js';

const state = { conversations: [], conversation: null, scenarios: [], provider: 'mock', analytics: null, ladderRunning: false };
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
  const tier = message.tier || tierFor(message.routed_model);
  const cost = calculateCost(message.routed_model, message.prompt_tokens || 0, message.completion_tokens || 0);
  return `<article class="message assistant">
    <div class="message-avatar">MR</div>
    <div class="message-body">
      <div class="message-content">${escapeHtml(message.content)}</div>
      <div class="message-meta">
        <span class="meta-chip model">${escapeHtml(message.routed_model || 'unknown model')}</span>
        <span class="meta-chip tier tier-${tier}">${tier}</span>
        <span class="meta-chip">L${message.complexity_level}</span>
        <span class="meta-chip">${message.total_tokens ?? 0} tokens</span>
        <span class="meta-chip">${message.latency_ms ?? 0} ms</span>
        <span class="meta-chip cost">${formatCost(cost)}</span>
        ${message.reasoning_tokens ? `<span class="meta-chip">${message.reasoning_tokens} reasoning</span>` : ''}
        ${message.cached_tokens ? `<span class="meta-chip">${message.cached_tokens} cached</span>` : ''}
        <span class="meta-chip">${escapeHtml(message.finish_reason || 'complete')}</span>
        <button class="meta-copy" type="button" data-copy>Copy</button>
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
}

async function sendPrompt(conversationId, content, complexityLevel) {
  const assistant = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ content, complexityLevel })
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
  state.conversation.messages.push(optimistic);
  renderConversation();
  elements.messageInput.value = '';
  setComposerBusy(true);
  try {
    const assistant = await sendPrompt(state.conversation.id, content, level);
    state.conversation.messages.push(assistant);
    if (state.conversation.title === 'New conversation') state.conversation.title = content.slice(0, 80);
    renderConversation();
    await refreshHistory();
    await refreshAnalytics();
  } catch (error) {
    state.conversation.messages.pop();
    elements.messageInput.value = content;
    renderConversation();
    showToast(error.message);
  } finally {
    setComposerBusy(false);
    elements.messageInput.focus();
  }
}

async function runLadder() {
  if (state.ladderRunning) return;
  state.ladderRunning = true;
  elements.runLadderButton.classList.add('running');
  elements.ladderProgress.hidden = false;
  elements.ladderHint.textContent = 'Routing ten prompts across a fresh conversation…';
  setComposerBusy(true);
  const total = state.scenarios.length;
  try {
    const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: `Ladder benchmark · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }) });
    state.conversation = { ...created, messages: [] };
    await refreshHistory();
    renderConversation();
    switchTab('analytics');
    for (let index = 0; index < total; index += 1) {
      const scenario = state.scenarios[index];
      elements.ladderProgressText.textContent = `${index + 1} / ${total} · L${scenario.level} ${scenario.title}`;
      elements.ladderBarFill.style.width = `${((index) / total) * 100}%`;
      state.conversation.messages.push({ role: 'user', content: scenario.prompt, complexity_level: scenario.level });
      renderConversation();
      const assistant = await sendPrompt(state.conversation.id, scenario.prompt, scenario.level);
      state.conversation.messages.push(assistant);
      renderConversation();
      await refreshAnalytics();
    }
    elements.ladderBarFill.style.width = '100%';
    elements.ladderProgressText.textContent = `${total} / ${total} · complete`;
    await refreshHistory();
    showToast('Ladder benchmark complete.');
  } catch (error) {
    showToast(`Ladder stopped: ${error.message}`);
  } finally {
    state.ladderRunning = false;
    elements.runLadderButton.classList.remove('running');
    setComposerBusy(false);
    elements.ladderHint.textContent = 'Auto-runs each level in a fresh conversation and fills analytics live.';
    setTimeout(() => { elements.ladderProgress.hidden = true; elements.ladderBarFill.style.width = '0%'; }, 4000);
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
elements.runLadderButton.addEventListener('click', runLadder);
elements.scenarioList.addEventListener('click', (event) => selectScenario(event.target.closest('[data-scenario]')?.dataset.scenario));
elements.historyList.addEventListener('click', (event) => {
  const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
  if (deleteId) { event.stopPropagation(); deleteConversation(deleteId); return; }
  const id = event.target.closest('[data-conversation]')?.dataset.conversation;
  if (id) openConversation(id);
});
elements.messages.addEventListener('click', (event) => { const button = event.target.closest('[data-copy]'); if (button) copyFromMeta(button); });
document.querySelector('.inspector-tabs').addEventListener('click', (event) => { if (event.target.dataset.tab) switchTab(event.target.dataset.tab); });
elements.menuButton.addEventListener('click', () => { elements.historyPanel.classList.add('open'); elements.scrim.classList.add('open'); });
elements.inspectorButton.addEventListener('click', () => { elements.inspectorPanel.classList.add('open'); elements.scrim.classList.add('open'); });
elements.closeInspector.addEventListener('click', closeDrawers);
elements.scrim.addEventListener('click', closeDrawers);

try {
  const [config, scenariosData, conversations, analytics] = await Promise.all([
    api('/api/config'), api('/api/scenarios'), api('/api/conversations'), api('/api/analytics')
  ]);
  Object.assign(state, { provider: config.provider, scenarios: scenariosData, conversations, analytics });
  const isFoundry = state.provider === 'foundry';
  elements.providerName.textContent = isFoundry ? 'Foundry router' : 'Mock router';
  elements.providerHint.textContent = isFoundry ? 'Live endpoint connected' : 'Ready without an endpoint';
  elements.headerProvider.textContent = isFoundry ? 'LIVE FOUNDRY' : 'SIMULATION';
  renderHistory(); renderScenarios(); renderAnalytics(); renderConversation();
  elements.logsClear?.addEventListener('click', () => { logEntries.length = 0; renderLogs(); });
  elements.clearAllButton?.addEventListener('click', async () => {
    if (!confirm('Delete all conversations and analytics? This cannot be undone.')) return;
    try {
      await api('/api/data', { method: 'DELETE' });
      window.location.reload();
    } catch (error) { showToast(error.message); }
  });
  renderLogs();
  subscribeToLogs();
} catch (error) { showToast(error.message); }
