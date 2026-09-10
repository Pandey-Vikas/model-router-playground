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

## Captured data

SQLite is created at `data/router-playground.db`. Each assistant message records:

- selected underlying model and provider
- selected complexity level
- prompt, completion, total, reasoning, and cached token counts
- request latency, finish reason, request ID, and timestamp
- full user and assistant content linked to its conversation

The Analytics tab summarizes model distribution, token counts, average latency, and the model selected at each complexity level.

## Connect Microsoft Foundry later

1. In Microsoft Foundry, deploy `model-router`. Balanced routing is the default and is suitable for this demo.
2. Copy `.env.example` to `.env`.
3. Change `MODEL_PROVIDER` to `foundry` and fill in the endpoint, deployment name, and API key.
4. Restart with `npm start`.

```dotenv
MODEL_PROVIDER=foundry
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
MODEL_ROUTER_DEPLOYMENT_NAME=model-router
AZURE_OPENAI_API_VERSION=2025-11-18
AZURE_OPENAI_API_KEY=YOUR-LOCAL-DEMO-KEY
```

The adapter calls the documented Chat Completions endpoint. The request uses the Model Router deployment name, while the response `model` field reveals the underlying model selected for that request. Usage details are stored without changing the UI or database schema.

For a shared or production deployment, replace API-key authentication with Microsoft Entra ID or store the credential in Azure Key Vault. Do not commit `.env`.

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