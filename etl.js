/* ============================================================================
 * claudemeter; shared ETL core (single source of truth).
 *
 * This module is consumed two ways:
 *   1. The browser (index.html) inlines it (via build.mjs) so the dashboard can
 *      compute cost entirely client-side from a picked folder; zero install.
 *   2. test/parity.mjs imports it in node and diffs its output against etl.py
 *      over shared fixtures, so the JS and Python implementations can never drift.
 *
 * Every behaviour here mirrors etl.py exactly. If you change pricing or logic,
 * change it in BOTH files in the same commit; the parity test enforces it.
 * ==========================================================================*/

// $/1M tokens (input, output). Cache write = input*1.25 (5m) / *2 (1h). Cache read = input*0.1
export const PRICING = {
  "claude-fable-5":   { input: 10.00, output: 50.00 },
  "claude-mythos-5":  { input: 10.00, output: 50.00 },
  "claude-opus-4-8":  { input: 5.00,  output: 25.00 },
  "claude-opus-4-7":  { input: 5.00,  output: 25.00 },
  "claude-opus-4-6":  { input: 5.00,  output: 25.00 },
  "claude-opus-4-5":  { input: 5.00,  output: 25.00 },
  "claude-opus-4-1":  { input: 5.00,  output: 25.00 },
  "claude-opus-4-0":  { input: 5.00,  output: 25.00 },
  "claude-sonnet-4-6":{ input: 3.00,  output: 15.00 },
  "claude-sonnet-4-5":{ input: 3.00,  output: 15.00 },
  "claude-sonnet-4-0":{ input: 3.00,  output: 15.00 },
  "claude-haiku-4-5": { input: 1.00,  output: 5.00 },
};
export const SONNET5_INTRO_CUTOVER = "2026-08-31";
export const SONNET5_INTRO = { input: 2.00, output: 10.00 };
export const SONNET5_STANDARD = { input: 3.00, output: 15.00 };

export const ENTRYPOINT_LABELS = {
  "cli": "Claude Code (terminal)",
  "claude-desktop": "Claude Code (Desktop)",
  "sdk-cli": "Programmatic (Agent SDK apps)",
  "local-agent": "Claude Cowork",
};
export const SURFACE_ORDER = [
  "Claude Code (terminal)",
  "Claude Code (Desktop)",
  "Claude Cowork",
  "Programmatic (Agent SDK apps)",
  "Other / unknown",
];

export function normalizeModel(model) {
  if (!model) return "unknown";
  let m = model;
  const b = m.indexOf("[");
  if (b >= 0) m = m.slice(0, b);
  if (m.startsWith("claude-haiku-4-5")) m = "claude-haiku-4-5";
  return m;
}

export function getPricing(model, dayStr) {
  if (model === "claude-sonnet-5") {
    return (dayStr && dayStr < SONNET5_INTRO_CUTOVER) ? SONNET5_INTRO : SONNET5_STANDARD;
  }
  return PRICING[model] || { input: null, output: null };
}

export function computeCost(model, dayStr, usage) {
  const p = getPricing(model, dayStr);
  if (p.input == null) return null;
  const input_tok = usage.input_tokens || 0;
  const output_tok = usage.output_tokens || 0;
  const cache_read = usage.cache_read_input_tokens || 0;
  const cache_creation = usage.cache_creation_input_tokens || 0;
  const cc = usage.cache_creation || {};
  let cc_5m = cc.ephemeral_5m_input_tokens || 0;
  let cc_1h = cc.ephemeral_1h_input_tokens || 0;
  // if the breakdown is empty but there IS cache-creation, treat it all as 5m (mirrors etl.py)
  if ((cc_5m + cc_1h) === 0 && cache_creation > 0) cc_5m = cache_creation;
  const PER_M = 1e6;
  const cost = (
    input_tok * p.input +
    output_tok * p.output +
    cc_5m * p.input * 1.25 +
    cc_1h * p.input * 2.0 +
    cache_read * p.input * 0.1
  ) / PER_M;
  return {
    cost,
    input_tokens: input_tok,
    output_tokens: output_tok,
    cache_read_tokens: cache_read,
    cache_write_tokens: cc_5m + cc_1h,
    total_tokens: input_tok + output_tok + cache_read + cc_5m + cc_1h,
  };
}

export function labelSurface(entrypoint) {
  return ENTRYPOINT_LABELS[entrypoint] || (entrypoint ? String(entrypoint) : "Other / unknown");
}

// Returns a fn: (isoTimestamp) -> "YYYY-MM-DD" in the given IANA tz (null = local).
export function makeDayKeyFn(tz) {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" };
  if (tz) opts.timeZone = tz;
  const fmt = new Intl.DateTimeFormat("en-CA", opts); // en-CA => ISO YYYY-MM-DD order
  return (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? null : fmt.format(d); };
}

// Classify a file by its relative path + basename.
export function classifyPath(relPath, baseName) {
  if (baseName === "audit.jsonl") return { kind: "skip" };
  if (baseName.endsWith(".jsonl")) {
    const isCowork = relPath.includes("local-agent-mode-sessions");
    let project;
    const m = relPath.match(/local_[0-9a-f-]{6,}/);
    if (isCowork && m) project = m[0];
    else {
      const after = relPath.split("/projects/")[1];
      project = after ? after.split("/")[0] : (relPath.split("/")[0] || "root");
    }
    return { kind: "transcript", isCowork, project };
  }
  if (/^local_[^/]*\.json$/.test(baseName)) return { kind: "title" };
  return { kind: "skip" };
}

// Parse a session-title metadata json object -> {cliSessionId, title, processName} | null
export function extractTitleRecord(obj) {
  if (!obj || !obj.cliSessionId) return null;
  return {
    cliSessionId: obj.cliSessionId,
    title: obj.title || null,
    processName: obj.processName || obj.vmProcessName || null,
  };
}

export function createAgg() {
  return {
    by_day: {}, by_model: {}, by_surface: {}, by_session: {},
    surface_sessions: {},   // surface -> Set(sessionId), for an accurate per-surface session count
    unknown_models: {}, total_messages: 0, parsed_messages: 0,
    earliest: null, latest: null,
  };
}

/*
 * Fold ONE transcript file into the aggregator. `lineIterable` yields raw line
 * strings (browser: from a stream; node: from split()). Dedup is per-file, by
 * requestId (then message.id, then uuid), keeping the last-seen line; because
 * Claude writes one line per content block, all repeating the same usage.
 */
export async function foldFile(agg, fileMeta, lineIterable, dayKeyFn) {
  // Per-file dedup by requestId, keeping only the FIELDS we actually price -
  // never the whole parsed line (message.content / tool_result blocks can be
  // huge; retaining them to end-of-file would defeat streaming and can OOM the
  // tab). Output is identical to storing the full record.
  const perRequest = new Map();
  let n = 0;
  for await (const raw of lineIterable) {
    const line = raw.trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    if (d.type !== "assistant") continue;
    const msg = d.message || {};
    if (!msg.usage) continue;
    if (msg.model === "<synthetic>") continue;
    const key = d.requestId || (msg.id ? "mid:" + msg.id : d.uuid);
    perRequest.set(key, {
      model: msg.model, ts: d.timestamp, usage: msg.usage,
      entrypoint: d.entrypoint, sessionId: d.sessionId,
    });
    if ((++n & 16383) === 0) await Promise.resolve(); // let a giant single-line-heavy file breathe
  }

  let f = 0;
  for (const rec of perRequest.values()) {
    if ((++f & 8191) === 0) await new Promise(r => setTimeout(r)); // yield within a very large file so the UI/progress can repaint
    const usage = rec.usage;
    agg.total_messages++;
    const model = normalizeModel(rec.model);
    const ts = rec.ts;
    if (!ts) continue;
    const day = dayKeyFn(ts);
    if (!day) continue;
    if (agg.earliest === null || ts < agg.earliest) agg.earliest = ts;
    if (agg.latest === null || ts > agg.latest) agg.latest = ts;

    const r = computeCost(model, day, usage);
    if (r === null) { agg.unknown_models[model] = (agg.unknown_models[model] || 0) + 1; continue; }
    agg.parsed_messages++;

    const surface = fileMeta.isCowork ? "Claude Cowork" : labelSurface(rec.entrypoint);
    const sid = rec.sessionId;

    const db = agg.by_day[day] || (agg.by_day[day] = { cost: 0, tokens: 0, count: 0, by_model: {}, by_surface: {} });
    db.cost += r.cost; db.tokens += r.total_tokens; db.count++;
    const dm = db.by_model[model] || (db.by_model[model] = { cost: 0, tokens: 0, count: 0 });
    dm.cost += r.cost; dm.tokens += r.total_tokens; dm.count++;
    const ds = db.by_surface[surface] || (db.by_surface[surface] = { cost: 0, tokens: 0, count: 0 });
    ds.cost += r.cost; ds.tokens += r.total_tokens; ds.count++;

    const mm = agg.by_model[model] || (agg.by_model[model] = { cost: 0, tokens: 0, count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    mm.cost += r.cost; mm.tokens += r.total_tokens; mm.count++;
    mm.input_tokens += r.input_tokens; mm.output_tokens += r.output_tokens;
    mm.cache_read_tokens += r.cache_read_tokens; mm.cache_write_tokens += r.cache_write_tokens;

    const sm = agg.by_surface[surface] || (agg.by_surface[surface] = { cost: 0, tokens: 0, count: 0 });
    sm.cost += r.cost; sm.tokens += r.total_tokens; sm.count++;

    if (sid) {
      (agg.surface_sessions[surface] || (agg.surface_sessions[surface] = new Set())).add(sid);
      const ss = agg.by_session[sid] || (agg.by_session[sid] = { cost: 0, tokens: 0, count: 0, models: {}, surface, project: fileMeta.project, first_ts: ts, last_ts: ts });
      ss.cost += r.cost; ss.tokens += r.total_tokens; ss.count++;
      ss.models[model] = (ss.models[model] || 0) + 1;
      if (ts < ss.first_ts) ss.first_ts = ts;
      if (ts > ss.last_ts) ss.last_ts = ts;
    }
  }
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

// Produce the final data.json-shaped object.
export function finalize(agg, { tz, titles, generatedAt } = {}) {
  titles = titles || {};
  const session_list = Object.entries(agg.by_session).map(([sid, s]) => ({
    sessionId: sid, title: (titles[sid] || {}).title || null,
    project: s.project, surface: s.surface, cost: s.cost, tokens: s.tokens, count: s.count,
    models: s.models, first_ts: s.first_ts, last_ts: s.last_ts,
  }));

  const counts = session_list.map(s => s.count).sort((a, b) => a - b);
  const byCount = [...session_list].sort((a, b) => b.count - a.count);
  const longest = byCount[0] || null;
  const session_stats = {
    count: session_list.length,
    median_msgs: percentile(counts, 0.5),
    p90_msgs: percentile(counts, 0.9),
    max_msgs: counts.length ? counts[counts.length - 1] : 0,
    over_500: counts.filter(c => c > 500).length,
    over_1000: counts.filter(c => c > 1000).length,
    over_2000: counts.filter(c => c > 2000).length,
    longest_session: longest ? { title: longest.title, msgs: longest.count, cost: longest.cost, surface: longest.surface } : null,
  };

  // accurate distinct-session count per surface (not derivable from top_sessions, which is capped)
  for (const s of Object.keys(agg.by_surface)) {
    agg.by_surface[s].sessions = agg.surface_sessions[s] ? agg.surface_sessions[s].size : 0;
  }

  session_list.sort((a, b) => b.cost - a.cost);
  const day_list = Object.keys(agg.by_day).sort().map(day => ({ day, ...agg.by_day[day] }));
  const total_cost = day_list.reduce((a, d) => a + d.cost, 0);
  const total_tokens = day_list.reduce((a, d) => a + d.tokens, 0);

  return {
    generated_at: generatedAt || null,
    earliest_ts: agg.earliest, latest_ts: agg.latest,
    timezone: tz || "local",
    total_cost, total_tokens,
    total_messages: agg.total_messages, parsed_messages: agg.parsed_messages,
    unknown_models: agg.unknown_models,
    days: day_list, by_model: agg.by_model, by_surface: agg.by_surface,
    top_sessions: session_list.slice(0, 100), total_sessions: session_list.length,
    session_stats,
  };
}
