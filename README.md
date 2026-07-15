# ◆ claudemeter

**See what your Claude usage actually costs. Zero install, data never leaves your machine.**

A local-first dashboard for the token cost of everything you run through Claude on your machine: **Claude Code** (terminal), **Claude Code in the Desktop app**, **Claude Cowork**, and your own **Agent-SDK** apps. It reads the usage logs these tools already write to disk, prices them from published per-model rates, and shows you where the money goes, by day, model, surface, and session.

It is the only usage tracker that breaks out **Claude Cowork** cost, which lives in a separate sandboxed-VM session tree most tools never read.

![MIT](https://img.shields.io/badge/license-MIT-blue) ![local-only](https://img.shields.io/badge/data-local--only-green) ![no telemetry](https://img.shields.io/badge/telemetry-none-green) ![no dependencies](https://img.shields.io/badge/dependencies-none-green)

> Add a dark-mode screenshot at `docs/screenshot.png` and uncomment the line below before publishing.
> <!-- ![claudemeter dashboard](docs/screenshot.png) -->

## Run it (no install)

**Fastest, if you have Node:**

```bash
npx @htrap94/claudemeter
```

It scans your local Claude folders, prices everything, and opens the dashboard. Nothing is installed permanently, nothing leaves your machine.

**Option A. Open it in your browser.** Download [`index.html`](index.html), double-click it, and click **“Choose your Claude folder.”** Everything is computed in the page. No Node, no Python, no server, nothing uploaded. (Or host `index.html` on any static site / GitHub Pages and visit the URL.)

When the picker opens, select the folder with your Claude data:

| Pick this folder | You get | Platform |
|---|---|---|
| `~/.claude` | Claude Code (terminal), Claude Code (Desktop), Agent-SDK apps | all |
| `~/Library/Application Support/Claude` | adds **Claude Cowork** usage + session titles | macOS |

Add both to capture everything, including Cowork.

> **macOS note:** both of those start with a dot or live under a hidden `~/Library`, so the file dialog hides them. Press **⌘⇧.** (Command-Shift-Period) in the picker to reveal hidden folders before selecting.

**Option B. Instant, refreshable local dashboard (needs Python 3.9+, no packages).**

```bash
python3 etl.py            # scans the default locations, writes data.json
python3 -m http.server 8815   # then open http://localhost:8815
```

`index.html` auto-loads a sibling `data.json` when served over HTTP, so this gives you a fast dashboard you can refresh anytime by re-running `etl.py`. Python 3.9+ ships with macOS; there are **no dependencies to install**.

## What it shows

- **Total cost, tokens, API calls, sessions, and days** at a glance.
- **Claude Cowork spotlight** shows a surface almost no tracker surfaces, isolated on its own.
- **Cost per day**, stacked by surface or by model, with hover detail.
- **Insights** cover the biggest cost driver, where spend concentrates (session power-law), cache-read efficiency, output verbosity by model, and week-over-week trend.
- **Model and surface breakdowns.**
- **Top sessions** by cost, sortable, so you can find the thread that ran up the bill.

## What it can (and can't) see

It reads two transcript trees that Claude tools write locally:

| Surface | Source on disk | Entrypoint tag |
|---|---|---|
| Claude Code (terminal) | `~/.claude/projects/**/*.jsonl` | `cli` |
| Claude Code (Desktop) | `~/.claude/projects/**/*.jsonl` | `claude-desktop` |
| Agent-SDK apps | `~/.claude/projects/**/*.jsonl` | `sdk-cli` |
| **Claude Cowork** | `~/Library/Application Support/Claude/local-agent-mode-sessions/**/.claude/projects/**/*.jsonl` | `local-agent` |

**It cannot see plain claude.ai web chat.** That runs server-side and is never logged locally, so there is no on-disk token record to read.

Costs are **estimates** from published per-token API pricing applied to the token counts in your logs, a useful proxy for where your usage goes, not a copy of your actual subscription invoice.

## Privacy

**Runs entirely on your machine.** The browser build reads your files through a local folder picker and analyses them in the page: no network requests, no accounts, no telemetry, nothing uploaded. Your generated `data.json` is git-ignored and never touches this repo. The whole tool is one HTML file and one Python script you can read end to end.

## How the cost is computed

Per assistant turn: `input × rate + output × rate + cache-write × (1.25× input for 5-min TTL, 2× for 1-hour) + cache-read × 0.1× input`, at each model's published $/Mtok. Claude writes one JSONL line per content block of a turn, all repeating the same usage object, so turns are **de-duplicated by request id** before pricing (skipping this is the #1 way these numbers get inflated 2–3×). Days are bucketed in your system's local timezone (the CLI reads it from your system and the browser uses your local zone; override the CLI with `--tz`).

## Advanced

```bash
python3 etl.py --tz America/New_York       # bucket days in another timezone
python3 etl.py --out /tmp/usage.json       # write elsewhere
python3 etl.py --root /some/dir            # scan a custom root (repeatable)
```

You can also **Export data.json** from the browser build to save the same artifact the CLI produces on that machine (both bucket days in your local timezone).

## Contributing / correctness

The pricing and aggregation logic lives once in [`etl.js`](etl.js) (used by the browser) and is mirrored in [`etl.py`](etl.py) (the CLI). A parity harness proves they produce byte-identical numbers so the two can never drift:

```bash
npm test        # generates fixtures, runs etl.py and etl.js over them, diffs every field
node build.mjs  # re-inline etl.js into index.html after editing it
```

`npm test` also accepts `CLAUDEMETER_REAL_ROOT=/path/to/sample` to cross-check against a copy of real transcripts. Any change to pricing or logic must land in **both** `etl.py` and `etl.js` or the harness fails. After editing `etl.js`, run `node build.mjs` to refresh the copy inlined into `index.html`.

## License

MIT. See [LICENSE](LICENSE).
