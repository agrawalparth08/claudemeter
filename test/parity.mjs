/* ============================================================================
 * Parity harness: prove etl.js (browser ETL) == etl.py (reference ETL) over the
 * shared fixture tree. If this exits 0, the two implementations agree and cannot
 * silently drift. Run: node test/parity.mjs   (or: npm test)
 *
 * It also runs, if available, over a real sample the caller points it at via
 * CLAUDEMETER_REAL_ROOT, for extra confidence beyond synthetic fixtures.
 * ==========================================================================*/
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as etl from "../etl.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..");
const TZ = "Asia/Kolkata"; // pin both sides so day-bucketing is identical

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Run etl.js over a root directory, feeding relPaths shaped like webkitRelativePath.
async function runJs(root) {
  const files = walk(root).sort();
  const dayKey = etl.makeDayKeyFn(TZ);
  const agg = etl.createAgg();
  const titles = {};

  // first pass: titles
  for (const fp of files) {
    const rel = relative(root, fp);
    const c = etl.classifyPath(rel, basename(fp));
    if (c.kind === "title") {
      try {
        const rec = etl.extractTitleRecord(JSON.parse(readFileSync(fp, "utf8")));
        if (rec) titles[rec.cliSessionId] = rec;
      } catch (_) {}
    }
  }
  // second pass: transcripts (sorted for deterministic first-seen surface/project)
  for (const fp of files) {
    const rel = relative(root, fp);
    const c = etl.classifyPath(rel, basename(fp));
    if (c.kind !== "transcript") continue;
    const lines = readFileSync(fp, "utf8").split("\n");
    await etl.foldFile(agg, { isCowork: c.isCowork, project: c.project }, lines, dayKey);
  }
  return etl.finalize(agg, { tz: TZ, titles });
}

function runPy(root, outPath) {
  execFileSync("python3", [join(REPO, "etl.py"), "--root", root, "--tz", TZ, "--out", outPath], { stdio: "pipe" });
  return JSON.parse(readFileSync(outPath, "utf8"));
}

// ---- deep comparison with float tolerance ----
const IGNORE_KEYS = new Set(["generated_at"]);
function approx(a, b) { return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)); }
const COST_KEYS = new Set(["cost", "total_cost"]);

const diffs = [];
function cmp(path, a, b) {
  if (IGNORE_KEYS.has(path.split(".").pop())) return;
  if (typeof a === "number" && typeof b === "number") {
    const isCost = COST_KEYS.has(path.split(".").pop());
    if (isCost ? !approx(a, b) : a !== b) diffs.push(`${path}: js=${a} py=${b}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { diffs.push(`${path}: array shape`); return; }
    if (a.length !== b.length) diffs.push(`${path}.length: js=${a.length} py=${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) cmp(`${path}[${i}]`, a[i], b[i]);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORE_KEYS.has(k)) continue;
      if (!(k in a)) { diffs.push(`${path}.${k}: missing in js`); continue; }
      if (!(k in b)) { diffs.push(`${path}.${k}: missing in py`); continue; }
      cmp(path ? `${path}.${k}` : k, a[k], b[k]);
    }
    return;
  }
  if (a !== b) diffs.push(`${path}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`);
}

async function checkRoot(label, root) {
  const tmp = mkdtempSync(join(tmpdir(), "claudemeter-parity-"));
  const jsOut = await runJs(root);
  const pyOut = runPy(root, join(tmp, "py.json"));
  // top_sessions ordering can tie on cost -> compare as a map keyed by sessionId,
  // then assert the #1-by-cost matches. Everything else compared structurally.
  const jsTop = Object.fromEntries(jsOut.top_sessions.map(s => [s.sessionId, s]));
  const pyTop = Object.fromEntries(pyOut.top_sessions.map(s => [s.sessionId, s]));
  const before = diffs.length;
  cmp("", { ...jsOut, top_sessions: jsTop }, { ...pyOut, top_sessions: pyTop });
  if (jsOut.top_sessions[0]?.sessionId !== pyOut.top_sessions[0]?.sessionId)
    diffs.push(`top_sessions[0] mismatch: js=${jsOut.top_sessions[0]?.sessionId} py=${pyOut.top_sessions[0]?.sessionId}`);
  const localDiffs = diffs.length - before;
  console.log(`  [${label}] total_cost js=${jsOut.total_cost.toFixed(6)} py=${pyOut.total_cost.toFixed(6)} · ` +
              `calls js=${jsOut.parsed_messages} py=${pyOut.parsed_messages} · ${localDiffs === 0 ? "OK" : localDiffs + " DIFFS"}`);
  return { jsOut, pyOut };
}

console.log("claudemeter parity: etl.js vs etl.py\n");
const fixtureRoot = join(HERE, "fixtures", "home");
const { jsOut } = await checkRoot("fixtures", fixtureRoot);

if (process.env.CLAUDEMETER_REAL_ROOT) {
  await checkRoot("real-sample", process.env.CLAUDEMETER_REAL_ROOT);
}

// sanity: fixtures must exercise real branches, not be empty
const assert = (cond, msg) => { if (!cond) diffs.push("ASSERT: " + msg); };
assert(jsOut.parsed_messages >= 6, "fixtures should price several calls");
assert(Object.keys(jsOut.unknown_models).length >= 1, "fixtures should hit an unknown model");
assert(jsOut.by_surface["Claude Cowork"], "fixtures should include a Cowork surface");
assert(jsOut.total_messages > jsOut.parsed_messages, "fixtures should have a skipped (no-ts) message");

if (diffs.length) {
  console.log(`\n✗ FAIL - ${diffs.length} difference(s):`);
  for (const d of diffs.slice(0, 60)) console.log("   " + d);
  process.exit(1);
}
console.log("\n✓ PASS - etl.js and etl.py agree on every field.");
