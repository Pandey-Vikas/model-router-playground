# RouteLab — Foundry Model Router Playground

A local-first workbench that shows how Microsoft Foundry's `model-router` picks a different underlying model based on prompt complexity — and lets you prove the cost / latency / quality tradeoff with real numbers, side by side.

Runs entirely on Node.js 22 built-ins (no bundler, no framework, no runtime dependencies). Ships with a browser setup wizard so a non-technical user can go from "I have an Azure subscription" to "the app is running" without opening a terminal.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [First-run setup (browser wizard)](#2-first-run-setup-browser-wizard)
3. [Starting the app](#3-starting-the-app)
4. [App tour](#4-app-tour)
5. [Manual chat — step by step](#5-manual-chat--step-by-step)
6. [Manual compare — step by step](#6-manual-compare--step-by-step)
7. [Quick benchmark — step by step](#7-quick-benchmark--step-by-step)
8. [Toolkit evaluation (LLM-as-judge)](#8-toolkit-evaluation-llm-as-judge)
9. [Compare dashboard — reading the numbers](#9-compare-dashboard--reading-the-numbers)
10. [Troubleshooting](#10-troubleshooting)
11. [Project layout & API](#11-project-layout--api)

---

## 1. Prerequisites

| Requirement | Version | Needed for |
| --- | --- | --- |
| Node.js | 22.5 or later | Everything (uses built-in `node:sqlite`, `fetch`, `--env-file-if-exists`) |
| Azure CLI (`az`) | any recent | Deploying router / baseline / judge models from the wizard |
| Python | 3.9 or later | Only if you use the **Toolkit evaluation** flow (Section 8) |
| Git | any | Only if you use the **Toolkit evaluation** flow (Section 8) |

You do **not** need any of these for mock mode — RouteLab will simulate the router offline.

---

## 2. First-run setup (browser wizard)

Setup is a separate mini-app that runs on port `3100`. It writes `.env`, deploys models with your consent, then exits. The main app never starts until you finish.

### 2a. Launch the wizard

```powershell
# Force setup even if .env already exists
.\start.ps1 -Setup

# Or on plain cmd
start.bat --setup
```

The launcher will:
- kill anything already listening on port 3000 or 3100
- open `http://localhost:3100/` in your browser
- run the setup server in the terminal (leave the window open)

### 2b. Wizard steps

1. **Sign in** — click *Sign in with Azure*. Uses device-code / browser Entra flow via `az login`. The launcher forces `AZURE_LOGIN_EXPERIENCE_V2=off` so the popup doesn't hide behind other windows.
2. **Pick a subscription** — dropdown of subscriptions the signed-in identity can see.
3. **Pick or create a Foundry account** — dropdown of existing `Microsoft.CognitiveServices/accounts`. (Creating a new one from the wizard UI is planned.)
4. **Batch-deploy models (recommended)** — expand *Deploy router + baseline in one click*. Default rows:
   - `mr-balanced` — model-router (balanced mode) · capacity 20 (= 20 000 TPM)
   - `mr-cost` — model-router (cost mode) · capacity 20
   - `mr-quality` — model-router (quality mode) · capacity 20
   - `gpt-5.2` — baseline chat model · capacity 1

   Untick anything you don't want, click *Deploy selected*. Each row updates in real time (`creating` → `success` / `failed`).
5. **Confirm & finish** — the wizard writes `.env` with your endpoint, deployment names, and Entra auth mode, then exits.

If you re-ran with `--setup` you'll see the message:

> Wizard exited. Run `.\start.ps1` to start the main app.

### 2c. Manual `.env` (skip the wizard)

Copy `.env.example` to `.env` and fill in:

```dotenv
MODEL_PROVIDER=foundry
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
MODEL_ROUTER_DEPLOYMENT_BALANCED=mr-balanced
MODEL_ROUTER_DEPLOYMENT_COST=mr-cost
MODEL_ROUTER_DEPLOYMENT_QUALITY=mr-quality
MODEL_ROUTER_DEPLOYMENT_NAME=mr-balanced      # default fallback
AZURE_OPENAI_API_VERSION=2025-11-18
# Omit AZURE_OPENAI_API_KEY to use Entra ID (recommended)
```

---

## 3. Starting the app

```powershell
.\start.ps1        # PowerShell (recommended)
start.bat          # cmd / File Explorer double-click
npm start          # if you prefer npm
```

The launcher:
1. Verifies Node.js is on `PATH`
2. Frees port 3000 if a previous run left a process listening
3. Opens `http://localhost:3000/`
4. Streams server logs to the terminal — `Ctrl+C` to stop

The app auto-runs the setup wizard on the very first launch (when `.env` is missing) and then continues to the main app. Subsequent launches skip straight to the main app.

---

## 4. App tour

The layout is fixed at four regions:

| Region | Contents |
| --- | --- |
| **Left sidebar** | Conversations list · New conversation · Environment health dot · `⚙ Change environment` (relaunches wizard) |
| **Center** | Chat pane with `Balanced / Cost / Quality` mode pills, message input, live route trace |
| **Right sidebar** | Tabs: **Scenarios**, **Analytics**, **Logs**, **Evaluation** |
| **Bottom-right** | Toast messages, health banner if Foundry is unreachable |

The **health dot** in the sidebar polls `/api/health/foundry` on a timer. Green = reachable, red = disabled all send / benchmark / eval buttons and shows a banner with a link back to the wizard.

---

## 5. Manual chat — step by step

Use this to hand-drive a single conversation and inspect what the router picked for each turn.

1. **Confirm the mode** — top of the chat pane shows three pills: `Balanced`, `Cost`, `Quality`. The one highlighted is the router deployment your next message will hit.
2. **Pick a scenario (optional)** — open the *Scenarios* tab on the right. Ten canned prompts spanning direct recall (level 1) to expert synthesis (level 10). Click any one to load it into the input box. Or type your own.
3. **Send** — click *Send* or press `Ctrl+Enter`.
4. **Read the response card** — under the assistant reply:
   - **Model badge** — the actual underlying model the router chose (e.g. `gpt-5-mini`, `claude-sonnet-4-5`)
   - **Tier chip** — `nano / mini / standard / advanced / reasoning / frontier / open`
   - **Cost** — computed at call time from `(prompt_tokens × input_rate + completion_tokens × output_rate) ÷ 1M`
   - **Tokens / latency / finish reason**
5. **Switch mode & repeat** — click `Cost`, send the same prompt. See which cheaper model gets picked and compare the response quality by eye.
6. **Open the Analytics tab** — scoped to the current conversation. Shows:
   - Model distribution bar chart
   - Complexity trail (per-level model choice)
   - Total tokens, avg latency, cost vs baseline

**Notes**
- Every message is persisted to `data/router-playground.db`. Reload the page → conversations are still there.
- Messages appear in the *Logs* tab in real time (SSE stream from `/api/logs/stream`) with the raw Foundry request/response.

---

## 6. Manual compare — step by step

Use this to put two or more of your existing conversations side by side without running a new benchmark.

1. Have at least two conversations in the sidebar.
2. Click the **Compare** button at the top of the left sidebar (or the *Compare selected* action in the conversations list).
3. Tick the conversations to include (2–4 works best).
4. Click *Open compare dashboard*.
5. Read the [Compare dashboard](#9-compare-dashboard--reading-the-numbers) — same view used by benchmarks and evaluations.
6. Switch between three views using the top toolbar:
   - **Dashboard** — KPI cards + bar charts + cost breakdown
   - **Per-question table** — one row per prompt, one column per conversation; failed calls show as red `✗ Failed` cells with the error snippet
   - **Side-by-side** — full columns with model distribution & complexity trail

---

## 7. Quick benchmark — step by step

Fires the same dataset at up to 4 deployments in parallel using RouteLab's native Entra-authed client. No Python, no judge, no toolkit. Result: 4 conversations auto-open in the Compare dashboard.

Best for demos, sanity checks, and validating a newly-deployed router.

### 7a. Prepare

Open the **Evaluation** tab in the right sidebar. Click the mode switch **Quick benchmark** (default).

### 7b. Pick a dataset

Under *1. Choose dataset*:

- **Built-in** — one of the shipped `.jsonl` datasets (scenarios30, scenarios20, scenarios10)
- **Toolkit dataset** — any `.jsonl` under `eval-toolkit/data/`
- **Your own** — click *Import JSONL*, paste text with one `{prompt, category, difficulty, level, title}` per line

### 7c. Pick endpoints

Fill 2–4 of:

| Slot | Purpose |
| --- | --- |
| **Balanced router** | Any `model-router` deployment; sends `routing.mode=balanced` per request |
| **Cost router** | Same, `routing.mode=cost` |
| **Quality router** | Same, `routing.mode=quality` |
| **Baseline model** | Any non-router deployment (e.g. `gpt-5.2`) — sent verbatim, no routing |

### 7d. Tune throughput (avoid 429s)

Two dropdowns cap total request rate:

| Control | Recommended | Effect |
| --- | --- | --- |
| **Concurrency** | 2 | Number of prompts in flight per endpoint |
| **Delay between requests** | 500 ms | Sleep between calls per worker |

At `concurrency=2` + `delay=500ms` you send ~4 requests/second per endpoint. If Azure returns HTTP 429, RouteLab **automatically retries up to 3 times** honoring the `Retry-After` header (see `src/providers/foundry.js`).

For very small quotas, drop to `concurrency=1` + `delay=2000ms` (~30 requests/minute).

### 7e. Run

1. Click **▶ Run quick benchmark**. Confirm the preview dialog.
2. A full-screen lockout appears — chat, ladder, and new-conversation are disabled while the benchmark runs. Same UX as toolkit evaluation.
3. Progress bar shows `endpoint · N/M · X ok · Y err` in real time.
4. When done, a toast fires and the **Open in Compare Dashboard** button appears.
5. Click it → jumps straight to the [Compare dashboard](#9-compare-dashboard--reading-the-numbers) with the 4 new benchmark conversations preselected.

### 7f. Past benchmarks

Section *5. Past quick benchmarks* on the Evaluation tab lists every historical batch with its dataset, endpoints, timestamps, and a *Open in Compare* button. Nothing is lost when you close the browser.

---

## 8. Toolkit evaluation (LLM-as-judge)

For rigorous accuracy scoring, RouteLab wraps the Microsoft AI Router Evaluation Toolkit (Python). Adds an LLM judge that scores each answer 1–5 on accuracy + helpfulness.

Longer run (~15 min for 30 prompts × 3 modes) but gives quality numbers alongside cost/latency.

### 8a. One-time install

On the Evaluation tab, switch to **Toolkit evaluation**, then click **Install / update toolkit**.

What it does:
- `git clone` the toolkit into `eval-toolkit/`
- Create a Python venv in `eval-toolkit/.venv/`
- `pip install` the toolkit's requirements
- Patch a few dashboard labels and bump judge parallelism (3 → 8) and max tokens (1024 → 256) for speed

Status chips at the top of the panel show: `Toolkit: installed`, `venv: ready`, `.env: written`, `Auth: Entra ID (patched)`.

### 8b. Deploy baseline + judge (if you don't have them)

Expand *Deploy a recommended model* — one-click deploys recommended baseline (`gpt-5.2`) and judge (`gpt-5.6-luna` or `claude-sonnet-4-5`) into your Foundry account.

### 8c. Pick router / baseline / judge

Under *Configure & run*:

- **Router deployment** — which `model-router` to evaluate (or leave blank to use `MODEL_ROUTER_DEPLOYMENT_BALANCED` from `.env`)
- **Baseline deployment** — a non-router chat model (e.g. `gpt-5.2`) used as the reference
- **Judge deployment** — a strong non-router model that scores each answer

### 8d. Dry run first

Click **Dry run (validate)** — walks the dataset through the toolkit without making any Foundry API calls. Confirms schema and dataset path are valid. No cost.

### 8e. Run live

- **Run live evaluation** — one router × one baseline × one judge. Standard toolkit flow.
- **Run 3-mode comparison** — same dataset three times, once per router mode (balanced / cost / quality), all judged with the same baseline. Great for the "which mode should I use" question.

Watch the live console under *3. Output*. Stop mid-run with the red *Stop* button.

### 8f. Read results

When the run finishes:
- **Open latest toolkit `dashboard.html`** — opens the toolkit's official HTML report in a new tab
- Section *4. Past evaluations* lists every past run with links back
- Each toolkit run is also auto-materialized as RouteLab conversations, so you can open the exact same comparison in RouteLab's Compare dashboard

---

## 9. Compare dashboard — reading the numbers

Opens from: benchmark completion, evaluation completion, or manual *Compare* button.

### 9a. Top strip: KPI cards (one per conversation)

Each card shows:

| Metric | What it means |
| --- | --- |
| **Responses** | Count of successful answers. If there were failures: shown as `10 / 3 failed` in red so numbers add up. |
| **Models used** | Distinct underlying models the router picked (router deployments themselves are never counted). |
| **Cost** | Sum of per-response cost, computed at call time from `input × input_rate + output × output_rate`. Click the `ⓘ` dot to expand the full per-model breakdown. |
| **Savings** | Percent cheaper than sending every prompt to the baseline model (`claude-opus-4-8` by default). |
| **Avg latency** | Wall time from POST to first byte, in ms. |
| **Tokens** | Total prompt + completion tokens summed across all responses. |
| **Avg quality** | Only appears after you click *Score all* on the modal — 1–5 rating from the judge. |

Badges appear on the winning card: `CHEAPEST`, `FASTEST`, `HIGHEST QUALITY`. A red `N FAILED` badge appears if any calls errored.

### 9b. Cost calculation drawer

Click the `ⓘ` dot in the Cost card. Expands a per-model table:

- Model name + tier
- Number of responses × prompt/completion tokens
- Actual cost for that model
- **Total (routed)** vs **If all on `claude-opus-4-8`** vs **Saved**
- Formula shown inline: `cost = (input × input_rate + output × output_rate) ÷ 1M`
- Rate source link: [Azure Foundry Models pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/)

### 9c. Charts row

Four bar charts side by side:
- Cost per conversation (USD)
- Avg latency (ms, lower = better)
- Savings vs baseline (%)
- Avg quality score (only if judge scored)
- Model distribution — stacked bar per conversation showing which underlying models answered how many prompts

### 9d. Switch to Per-question table

Top toolbar → **Per-question table**. Rows = prompts (sorted by level), columns = conversations.

Each cell shows the model that answered + tokens + latency + (if scored) accuracy/helpfulness. Failed prompts show:

> `✗ Failed` — with the error snippet inline and full message on hover.

If a level had partial success + failure across the conversations, both appear.

### 9e. Switch to Side-by-side

Top toolbar → **Side-by-side**. Full-column view with model distribution and complexity trail per conversation. Handy for narrated demos.

### 9f. Score all (add quality)

Above the KPI cards: *Judge deployment* dropdown + *Score all conversations*. Runs the picked judge over every response in every selected conversation. Adds accuracy / helpfulness columns and the *Avg quality* KPI.

---

## 10. Troubleshooting

### Port 3000 already in use

The launcher (`start.ps1` / `start.bat`) auto-kills the listener before binding. If you see `EADDRINUSE :::3000` anyway, run:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

### Foundry health dot is red

The dot polls `/api/health/foundry`. Common causes:

- `.env` missing or endpoint typo — click *⚙ Change environment* in the sidebar to relaunch the wizard
- Not signed in — run `az login` in a terminal, refresh
- Missing role — need `Cognitive Services OpenAI User` on the Foundry account
- Firewall / VNet on the Foundry account blocking your IP

### Benchmark shows 429 errors

The retry logic catches most, but if you exhaust 3 retries the response shows as a `✗ Failed` cell. Fixes in order:

1. Lower **Concurrency** to 1
2. Raise **Delay between requests** to 2000 ms
3. Deploy the router in a region with higher default quota (East US 2 usually has more headroom than Sweden Central for open models)
4. Request a quota increase: https://aka.ms/oai/quotaincrease

### Setup wizard doesn't launch

Manually run:

```powershell
node --disable-warning=ExperimentalWarning scripts/setup-server.js
```

Then browse to `http://localhost:3100/`.

---

## 11. Project layout & API

### Layout

```text
public/                    Browser HTML, CSS, and JS (no bundler)
  index.html                 Main app shell
  app.js                     All UI logic
  pricing.js                 Shared pricing + tier catalog (browser + server)
  styles.css                 Single stylesheet
scripts/
  setup-server.js            Wizard backend (port 3100)
  setup.html                 Wizard UI
  patch-toolkit-labels.js    Post-install patches for the eval toolkit
src/
  server.js                  Main HTTP server (port 3000)
  db.js                      SQLite schema + migrations + analytics queries
  benchmark.js               Native quick-benchmark orchestrator
  eval.js                    Toolkit orchestration + management-plane deploys
  scenarios.js               10 built-in complexity scenarios
  providers/
    foundry.js               Foundry Chat Completions adapter (Entra + retry)
    mock.js                  Offline routing simulation
test/api.test.js             End-to-end API tests
start.ps1 / start.bat        Cross-shell launchers with port cleanup
setup.bat                    Standalone wizard launcher
data/router-playground.db    SQLite (auto-created)
```

### API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/scenarios` | Ten built-in complexity prompts |
| `GET/POST` | `/api/conversations` | List / create conversations |
| `GET/DELETE` | `/api/conversations/:id` | Read / delete a conversation |
| `POST` | `/api/conversations/:id/messages` | Send a prompt, persist routed response |
| `POST` | `/api/conversations/:id/score` | Judge the conversation, store quality per response |
| `GET` | `/api/analytics?conversationId=...` | Per-conversation KPIs, model breakdown, per-level trail, per-level failure list |
| `GET` | `/api/health/foundry` | Reachability probe (used by sidebar health dot) |
| `POST` | `/api/benchmark/run` | Start quick benchmark. Body: `{datasetPath, endpoints[], concurrency, requestDelayMs}` |
| `POST` | `/api/benchmark/stop` | Stop the running quick benchmark |
| `GET` | `/api/benchmark/stream` | SSE progress + per-endpoint status |
| `GET` | `/api/benchmark/history` | Past benchmarks with conversation IDs |
| `GET/POST` | `/api/eval/*` | Toolkit orchestration — install, deployments, deploy-router, deploy-batch, dataset, run, dry-run, stop, status, history, report |
| `GET` | `/api/logs/stream` | SSE stream of every Foundry request/response |
| `POST` | `/api/setup/launch` | Spawn the setup wizard on port 3100 |

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MODEL_PROVIDER` | `mock` | Set to `foundry` for live calls |
| `AZURE_OPENAI_ENDPOINT` | — | e.g. `https://acme.openai.azure.com` |
| `MODEL_ROUTER_DEPLOYMENT_NAME` | — | Fallback deployment |
| `MODEL_ROUTER_DEPLOYMENT_BALANCED/COST/QUALITY` | — | Per-mode deployments (set by wizard) |
| `AZURE_OPENAI_API_VERSION` | `2025-11-18` | Chat Completions API version |
| `AZURE_OPENAI_API_KEY` | — | Optional; omit to use Entra ID via `az` |
| `MODEL_ROUTER_MAX_OUTPUT_TOKENS` | model default | Cap for `max_completion_tokens` |
| `MODEL_ROUTER_TIMEOUT_MS` | `120000` | Per-request timeout |
| `MODEL_ROUTER_MAX_RETRIES` | `3` | 429 retries with `Retry-After` honoring |
| `MODEL_ROUTER_SYSTEM_PROMPT` | `Be brief.` | System prompt for every request |

### Data model

SQLite is created at `data/router-playground.db`. Every assistant message stores:

- routed underlying model + provider + finish reason + request ID
- complexity level, prompt/completion/reasoning/cached/total tokens
- latency in ms
- **cost_usd, input_rate_usd_per_million, output_rate_usd_per_million, rate_source** — locked in at call time (won't drift when Azure changes prices)
- link back to conversation, timestamp

Errored responses store `finish_reason='error'` with the raw error text — these are excluded from analytics aggregates but surfaced as `✗ Failed` cells in the Compare dashboard.

---

## References

- [How to use model router for Microsoft Foundry](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/model-router)
- [Azure Foundry Models pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/)
- [Cognitive Services OpenAI User role](https://learn.microsoft.com/azure/ai-services/openai/how-to/role-based-access-control)
- [Request a quota increase](https://aka.ms/oai/quotaincrease)
