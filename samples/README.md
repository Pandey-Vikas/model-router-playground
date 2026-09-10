# Sample datasets

Use these to try the **Import your dataset** feature in RouteLab.

- **[mixed-prompts.jsonl](mixed-prompts.jsonl)** — 15 prompts spanning summarization, code, reasoning, extraction, math, planning, translation, classification, and creative writing. Easy / medium / hard mix — good default for a dry-run.

Where to use them:

| Where | What happens |
| --- | --- |
| **Scenarios → Import your dataset** | Runs each prompt through the current mode (Balanced / Cost / Quality). Captures model, tokens, latency, cost. |
| **Evaluation → Upload your own dataset** | Runs the toolkit's full pipeline: router vs baseline, judge scoring, HTML dashboard. |

## Accepted file formats

Four formats — RouteLab auto-detects from the extension:

| Format | Extension | Notes |
| --- | --- | --- |
| JSONL | `.jsonl` | **Recommended.** One JSON object per line. |
| JSON array | `.json` | An array of objects. |
| CSV | `.csv` | First row is the header. Must have a `prompt` column. |
| Plain text | `.txt` | One prompt per line. |

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | ✅ | The text sent to the router. Aliases accepted: `input`, `text`, `question`. |
| `id` | optional | Unique identifier. Auto-generated on upload if missing. |
| `title` | optional | Short label shown in the Compare view. |
| `category` | optional | Groups results in the toolkit dashboard (e.g. `summarization`, `code_generation`). |
| `difficulty` | optional | `easy` / `medium` / `hard`. Used by the toolkit's difficulty breakdown. |
| `level` | optional | 1–30 integer. RouteLab uses it for the complexity trail; auto-derived from prompt length if missing. |

## Minimal example (JSONL)

```jsonl
{"prompt": "What is the capital of Australia?"}
{"prompt": "Write a Python one-liner that reverses a string."}
{"prompt": "Summarise the last quarterly earnings call in 3 bullets."}
```

## Full example (JSONL)

```jsonl
{"id": "qa-001", "prompt": "What is the capital of Australia?", "category": "qa", "difficulty": "easy"}
{"id": "cod-002", "prompt": "Write a Python function flatten(nested_list) that flattens one level.", "category": "code_generation", "difficulty": "medium"}
{"id": "rsn-001", "prompt": "Give a ranked list of hypotheses for p99 latency spikes every 15 min.", "category": "reasoning", "difficulty": "hard"}
```

## CSV example

```csv
id,prompt,category,difficulty
qa-001,What is the capital of Australia?,qa,easy
cod-002,Write a Python function flatten(nested_list) that flattens one level.,code_generation,medium
```

## Plain-text example

```text
What is the capital of Australia?
Write a Python one-liner that reverses a string.
Summarise the last quarterly earnings call in 3 bullets.
```

## Tips

- Keep **10–50 prompts** for a smoke test, **100+** for a meaningful comparison.
- Include a mix of easy / medium / hard — the router's value only shows when the workload is diverse.
- Use realistic prompts from your workload, not toy examples.
- Quote strings with commas in CSV: `"Hello, world"`.
