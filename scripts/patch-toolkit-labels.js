#!/usr/bin/env node
// Rewrites the dashboard subtitle + report exec summary so it's clear what's being compared.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLKIT_DIR = join(rootDir, 'eval-toolkit');

function patch(filePath, replacements, label) {
  if (!existsSync(filePath)) { console.log(`[skip] ${label}: not found`); return; }
  let text = readFileSync(filePath, 'utf8');
  let changed = false;
  for (const { find, replace } of replacements) {
    if (text.includes(find)) { text = text.replaceAll(find, replace); changed = true; }
  }
  if (changed) { writeFileSync(filePath, text, 'utf8'); console.log(`[ok]   ${label}: patched`); }
  else console.log(`[skip] ${label}: already patched or original strings not present`);
}

const dashboardPath = join(TOOLKIT_DIR, 'src', 'dashboard.py');
patch(dashboardPath, [
  {
    find: '<div class="subtitle">{_esc(eval_name)} &mdash; {rm.total_requests} prompts &mdash; Model Router vs {_esc(baseline_label)}</div>',
    replace: '<div class="subtitle">{rm.total_requests} prompts &middot; <b>Router deployment</b> (picks a model per prompt) <b>vs</b> <b>Fixed baseline</b> &ldquo;{_esc(baseline_label)}&rdquo;</div>'
  }
], 'dashboard.py subtitle');

const reportPath = join(TOOLKIT_DIR, 'src', 'report.py');
patch(reportPath, [
  {
    find: 'f"Model Router was evaluated against **{config.baseline.deployment_name}** "',
    replace: 'f"Router deployment (which picks a model per prompt) was compared against the fixed baseline **{config.baseline.deployment_name}** "'
  }
], 'report.py exec summary');

console.log('Done. Restart any running eval processes to pick up changes.');
