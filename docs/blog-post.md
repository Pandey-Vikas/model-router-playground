# RouteLab: A one-click playground for Microsoft Foundry Model Router

*Prove your Model Router routing decisions save cost and preserve quality — without spending a day wiring endpoints, keys, and evaluation scripts.*

> **TL;DR** — RouteLab is a lightweight, open-source playground for [Microsoft Foundry Model Router](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/model-router). It ships a **guided setup wizard** that provisions your Azure Foundry resource, Project, and the three router deployments (Balanced / Cost / Quality) end-to-end — plus a UI that runs **Manual** and **Automation** evaluations against real prompts, with live cost, latency, and routing telemetry. Everything runs locally on Node.js 22, no npm dependencies, no bundlers, and Microsoft Entra ID as the *only* auth path.
>
> Repo: <https://github.com/Pandey-Vikas/model-router-playground>

---

## Why we built this

Model Router is one of the most cost-impactful features in Azure Foundry — it dispatches each request to the right underlying model based on complexity, so you stop paying frontier-model prices for "what is 2+2?" prompts. But *proving* the savings to a stakeholder takes work: you need three deployments (Balanced, Cost, Quality), realistic prompts, side-by-side runs, quality scoring with an LLM-as-judge, and cost math against a fixed baseline.

RouteLab collapses all of that into a browser tab.

## What makes RouteLab different

- **Six-step setup wizard, no portal juggling.** From an empty subscription to a fully-provisioned Foundry account + Project + three router deployments + role assignments — in a single flow.
- **Entra ID only.** No `AZURE_OPENAI_API_KEY` anywhere. The wizard grants `Cognitive Services User`, `Cognitive Services OpenAI User`, `Azure AI User`, and `Azure AI Project Manager` to your signed-in user automatically.
- **Real Foundry Project.** Not a plain classic AI Services account — a full `Microsoft.CognitiveServices/accounts/projects` sub-resource so the account appears in the new Foundry portal (ai.azure.com).
- **Two evaluation modes side-by-side.** Manual chat (see routing decisions per prompt) and Automation (Microsoft's official [Model-Router-Auto-Evaluation](https://github.com/microsoft-foundry/Model-Router-Auto-Evaluation) toolkit, wired up so you don't have to).
- **Live Azure Retail Prices integration.** Baseline cost comparison uses the real Azure Retail Prices API — refresh on demand from the Analytics tab.
- **Runs on Node 22 built-ins.** No `npm install`. No webpack. Just `node src/server.js`.

---

## The Setup Wizard USP

Most Foundry demos start with a wall of `az cli` commands. RouteLab replaces those with a browser wizard that does the whole thing.

> 📸 **Insert screenshot:** `setup-wizard-step1-prereqs.png` — Prerequisites step (Node / Azure CLI / Python / Git chips, all green ticks).

**Six steps, ~4 minutes end-to-end:**

1. **Prerequisites** — detects Node, Azure CLI, Python, Git. Missing tools install via `winget` inline.
2. **Sign in** — kicks off `az login` in your default browser.
3. **Subscription** — pick from a dropdown.
4. **Resource group + Foundry account** — reuse or create both, all Azure regions supported. The wizard sets `--custom-domain`, creates a `default-project` sub-resource via the `2025-04-01-preview` API, and grants the four RBAC roles above.
5. **Deployments** — one click deploys `mr-balanced`, `mr-cost`, and `mr-quality` at Global Standard capacity 20. A **green tick per deployment** confirms creation.
6. **Launch** — writes `.env`, starts the app on port 3000, opens your browser.

> 📸 **Insert screenshot:** `setup-wizard-step5-deployments.png` — the three router deployments with green ticks.

The wizard is not "best effort" — it refuses to advance if it can't confirm data-plane access. If a role assignment fails, it stops and tells you exactly why.

---

## Manual Evaluation

Pick from **30 built-in complexity scenarios** or type your own prompt, watch Router pick the underlying model in real time, and compare conversations side by side.

> 📸 **Insert screenshot:** `manual-eval-chat.png` — Manual Evaluation tab showing a mid-conversation ladder with the model chip, latency, and tokens on each assistant message.

**Steps:**

1. **Pick a mode** — Balanced / Cost / Quality (three pills at the top).
2. **Send a prompt** — either click a scenario ("Explain quantum entanglement to a 10-year-old") or type your own.
3. **See the routing decision** — each assistant message shows the underlying model Router chose (`gpt-4o-mini`, `gpt-4.1`, `gpt-5.2` …), token counts, and latency.
4. **Run the "ladder"** — one click sends all 30 scenarios sequentially through the current mode so you can see complexity-vs-model behavior emerge.
5. **Compare** — Analytics tab → Compare → tick three conversations (one per mode) → **Show comparison** for the per-question side-by-side table.

The **Foundry context card** at the top of the tab makes it unmistakable which Azure resource and Project the request lands on — great for live demos.

---

## Automation Evaluation

RouteLab wraps Microsoft's official [Model-Router-Auto-Evaluation](https://github.com/microsoft-foundry/Model-Router-Auto-Evaluation) toolkit and drives it from the UI. **You don't touch Python.**

> 📸 **Insert screenshot:** `auto-eval-tab.png` — Auto Evaluation tab with the streaming console showing "Evaluating: 100%" and the run summary card.

**Steps:**

1. **Install toolkit** — one click. RouteLab does a shallow `git clone`, creates a Python venv, `pip install -e .`, and — critically — **auto-patches the toolkit's `client.py` and `judge.py`** so both fall back to Microsoft Entra ID (`az account get-access-token`) when no API key is present. The streaming console shows every step; benign pip/git noise stays neutral, real errors show red.
2. **Pick or deploy a baseline / judge** — thirteen recommended options across GPT-5.6, GPT-5, GPT-4.1, GPT-4o, o4-mini, o3-mini, and Claude Sonnet 4.5. Click **Deploy** and the model appears in the dropdown two minutes later.
3. **Pick a dataset** — 15 or 30 built-in scenarios, any toolkit-bundled dataset, or upload your own (`.jsonl` / `.json` / `.csv` / `.txt` — RouteLab auto-fills missing `id`s).
4. **Choose Router / Baseline / Judge** — three dropdowns, pre-populated on page load.
5. **Dry-run first** — validates the dataset without spending API budget.
6. **Run live evaluation** — full run, streams progress bar and per-prompt results. Chat is locked during the run so you can't cross-contaminate.
7. **Open report** — one click opens the toolkit's dashboard with quality scores (LLM-as-judge, pairwise + absolute), cost delta, and win-rate.

Total time from an empty subscription to a full 30-prompt evaluation report: **~15 minutes**.

---

## Under the hood

RouteLab deliberately stays tiny:

- **Runtime:** Node.js 22 built-ins only — no `npm install` for the app itself (native `fetch`, `node:sqlite`, `node:http`, `--env-file-if-exists`).
- **Frontend:** 3 files — `index.html`, `styles.css`, `app.js`. No framework, no bundler. CSS variables drive three themes (Light / Dark / Cyber).
- **Storage:** SQLite at `data/router-playground.db`, one table per conversation, full request/response bodies persisted with token usage.
- **Setup wizard:** a second small Node server on port 3100 that shells out to `az` — the same tool your enterprise already trusts.
- **Automation eval:** the actual toolkit is the official Microsoft repo; RouteLab is a driver, not a fork.

Everything is < 5,000 lines of code. Read it in an afternoon.

---

## Try it now

```powershell
git clone https://github.com/Pandey-Vikas/model-router-playground
cd model-router-playground
.\start.ps1 -Setup
```

The wizard opens on <http://localhost:3100>. Follow six steps. When it's done, RouteLab launches on <http://localhost:3000> with your Foundry resource wired up.

If you're already provisioned, just `.\start.ps1` — it skips the wizard.

---

## Closing

Model Router is one of the easiest wins in Foundry today, but only if the story is *believable*. RouteLab gives you the wizard, the dashboards, and the evidence to make that story in an afternoon.

Give it a try, star the repo, and let us know which routing modes actually save you the most on your workload.

**GitHub:** <https://github.com/Pandey-Vikas/model-router-playground>
**Docs:** [How to use Model Router for Microsoft Foundry](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/model-router)
**Toolkit:** [microsoft-foundry/Model-Router-Auto-Evaluation](https://github.com/microsoft-foundry/Model-Router-Auto-Evaluation)

---

*Written for the Azure AI Foundry Blog on the Microsoft Community Hub.*
