# RouteLab: Foundry Model Router Playground

A small, local-first demonstration of how Microsoft Foundry Model Router selects different models as prompt complexity changes. It includes persistent conversations, ten complexity scenarios, per-response telemetry, and aggregate routing analytics.

## Why it is lightweight

- No frontend framework or bundler
- No web framework or ORM
- No npm runtime or development dependencies
- Uses Node.js built-in HTTP, `fetch`, test runner, and SQLite APIs
- Three static browser files and a small JavaScript server
- Mock mode works offline and without Azure credentials

The only prerequisite is Node.js 22.5 or later. The native `node:sqlite` API is still marked experimental by Node 22, so scripts suppress its informational warning. The database format is standard SQLite.

## Start locally

```powershell
cd C:\Users\vikaspandey\model-router-playground
npm start
```

Open [http://localhost:3000](http://localhost:3000). Choose any scenario from level 1 through 10, then send it. Mock mode deterministically varies the selected model so the complete UI and analytics can be demonstrated before an endpoint exists.

For automatic restart during development:

```powershell
npm run dev
```

Run validation:

```powershell
npm run check
```

## Guided setup wizard

To go from an empty subscription to a working Foundry Model Router demo without touching the portal, run:

```powershell
.\start.ps1 -Setup
```

The wizard opens on <http://localhost:3100> and walks through six steps:

1. **Prerequisites** — verifies Node 22+, Azure CLI, and `az login`. Missing tools can be installed inline via winget.
2. **Subscription** — picks the subscription.
3. **Resource group** — reuses an existing one or creates a new one in any Azure region.
4. **Foundry account** — reuses an existing AI Services / OpenAI account, or creates a new `AIServices` account. Newly-created accounts automatically get:
   - a custom subdomain (`https://<name>.cognitiveservices.azure.com`) so Entra ID works,
   - role assignments on the signed-in user: `Cognitive Services User`, `Cognitive Services OpenAI User`, plus `Azure AI User` / `Azure AI Project Manager` when the tenant defines them.
   A **Grant me access** button on the deployment step applies the same roles to any resource you pick later.
5. **Deployments** — creates three `model-router` deployments (`mr-balanced`, `mr-cost`, `mr-quality`) at Global Standard capacity 20, or lets you map existing deployments to the three routing modes.
6. **Write `.env`** — previews and writes the `.env` file, then launches the main app on port 3000.

## Captured data

SQLite is created at `data/router-playground.db`. Each assistant message records:

- selected underlying model and provider
- selected complexity level
- prompt, completion, total, reasoning, and cached token counts
- request latency, finish reason, request ID, and timestamp
- full user and assistant content linked to its conversation

The Analytics tab summarizes model distribution, token counts, average latency, and the model selected at each complexity level. A baseline-model picker (with a "Live prices" button that pulls the Azure Retail Prices API) lets you compare Router costs against a fixed premium model.

## Connect Microsoft Foundry manually

If you'd rather configure things by hand:

1. In Microsoft Foundry, deploy `model-router` (create three deployments if you want to exercise all three routing modes from the UI).
2. Give your signed-in user the `Cognitive Services User` and `Cognitive Services OpenAI User` roles on the AI Services / OpenAI resource.
3. Copy `.env.example` to `.env` and fill in the Foundry block:

```dotenv
MODEL_PROVIDER=foundry
PORT=3000
DATABASE_PATH=./data/router-playground.db

AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.cognitiveservices.azure.com
AZURE_OPENAI_API_VERSION=2024-10-21

MODEL_ROUTER_DEPLOYMENT_NAME=mr-balanced
MODEL_ROUTER_DEPLOYMENT_BALANCED=mr-balanced
MODEL_ROUTER_DEPLOYMENT_COST=mr-cost
MODEL_ROUTER_DEPLOYMENT_QUALITY=mr-quality

AZURE_FOUNDRY_RESOURCE_NAME=YOUR-RESOURCE
AZURE_FOUNDRY_RESOURCE_GROUP=YOUR-RESOURCE-GROUP
```

4. Run `az login`, then `npm start`.

Authentication is **Microsoft Entra ID via the Azure CLI**. There is no API-key path in the demo — the adapter calls `az account get-access-token --resource https://cognitiveservices.azure.com` on every request. Endpoints must be on `*.cognitiveservices.azure.com` (AI Services) or `*.openai.azure.com` (Azure OpenAI). Accounts created without a custom subdomain will fail DNS lookups; the setup wizard handles this automatically.

The response `model` field reveals the underlying model selected for each request. Usage details are stored without changing the UI or database schema.

Current Model Router documentation: [How to use model router for Microsoft Foundry](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/model-router)

## Project layout

```text
public/                 Browser HTML, CSS, and JavaScript
src/db.js               SQLite schema and queries
src/providers/mock.js   Offline routing simulation
src/providers/foundry.js Foundry Chat Completions adapter
src/scenarios.js        Ten prompt-complexity examples
src/server.js           Static server and JSON API
test/api.test.js        End-to-end API tests
```

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/scenarios` | List the ten complexity prompts |
| `GET/POST` | `/api/conversations` | List or create conversations |
| `GET/DELETE` | `/api/conversations/:id` | Read or delete a conversation |
| `POST` | `/api/conversations/:id/messages` | Send a prompt and persist its routed response |
| `GET` | `/api/analytics` | Read aggregate routing telemetry |