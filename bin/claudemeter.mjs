#!/usr/bin/env node
/* ============================================================================
 * claudemeter CLI - `npx @htrap94/claudemeter`
 *
 * Scans your local Claude transcript trees (reading the filesystem directly, so
 * no folder-picker and no macOS hidden-folder friction), prices them with the
 * SAME shared ETL the browser uses (etl.js - kept byte-identical to etl.py by
 * test/parity.mjs), then serves the self-contained dashboard and opens it.
 *
 * Everything runs locally. No data leaves your machine; no network calls.
 *
 *   npx @htrap94/claudemeter                 scan, serve, and open the dashboard
 *   npx @htrap94/claudemeter --no-open       don't auto-open the browser
 *   npx @htrap94/claudemeter --port 9000     choose the port
 *   npx @htrap94/claudemeter --tz UTC        day-bucket in a specific IANA timezone
 *   npx @htrap94/claudemeter --root DIR      scan a custom root instead of defaults (repeatable)
 *   npx @htrap94/claudemeter --out FILE      just write data.json and exit (no server)
 * ==========================================================================*/
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as etl from "../etl.js";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const a = { roots: [], port: null, tz: null, open: true, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--help" || v === "-h") a.help = true;
    else if (v === "--no-open") a.open = false;
    else if (v === "--port") a.port = parseInt(argv[++i], 10);
    else if (v === "--tz") a.tz = argv[++i];
    else if (v === "--root") a.roots.push(argv[++i]);
    else if (v === "--out") a.out = argv[++i];
  }
  return a;
}

function defaultRoots() {
  const h = homedir();
  return [
    join(h, ".claude", "projects"),
    join(h, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    join(h, "Library", "Application Support", "Claude", "claude-code-sessions"),
  ];
}

function walk(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return out; }                              // unreadable dir -> skip
  for (const e of entries) {
    const p = join(root, e.name);
    try {
      if (e.isDirectory()) walk(p, out);
      else if (e.isFile()) out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

async function scan(roots, tz) {
  const dayKey = etl.makeDayKeyFn(tz || null);
  const agg = etl.createAgg();
  const titles = {};
  const files = [];
  for (const r of roots) { try { if (statSync(r).isDirectory()) walk(r, files); } catch {} }
  files.sort();

  // classify once; titles first, then transcripts in sorted (deterministic) order
  const norm = p => p.replace(/\\/g, "/");
  const transcripts = [];
  for (const fp of files) {
    const c = etl.classifyPath(norm(fp), basename(fp));
    if (c.kind === "title") {
      try {
        const rec = etl.extractTitleRecord(JSON.parse(readFileSync(fp, "utf8")));
        if (rec) titles[rec.cliSessionId] = rec;
      } catch {}
    } else if (c.kind === "transcript") {
      transcripts.push({ fp, isCowork: c.isCowork, project: c.project });
    }
  }
  let done = 0;
  for (const t of transcripts) {
    // stream line-by-line so a multi-hundred-MB transcript never loads whole
    const rl = createInterface({ input: createReadStream(t.fp), crlfDelay: Infinity });
    await etl.foldFile(agg, { isCowork: t.isCowork, project: t.project }, rl, dayKey);
    if ((++done % 200) === 0) process.stderr.write(`  scanned ${done}/${transcripts.length} transcripts\r`);
  }
  process.stderr.write(" ".repeat(50) + "\r");
  return { data: etl.finalize(agg, { tz: tz || Intl.DateTimeFormat().resolvedOptions().timeZone, titles, generatedAt: new Date().toISOString() }), nFiles: transcripts.length };
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch {}
}

function serve(indexHtml, dataJson, wantPort, open) {
  const body = { "/": indexHtml, "/index.html": indexHtml };
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/data.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(dataJson); return; }
    if (body[path]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body[path]); return; }
    res.writeHead(404); res.end("not found");
  });
  let port = wantPort || 8899;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && !wantPort && port < 8920) { server.listen(++port, "127.0.0.1"); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  claudemeter is live at  ${url}\n  (all local; press Ctrl+C to stop)\n`);
    if (open) openBrowser(url);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`claudemeter - local-first Claude usage & cost dashboard (nothing leaves your machine)

Usage:
  npx @htrap94/claudemeter [options]

Options:
  --no-open       don't auto-open the browser (just print the URL)
  --port <n>      serve on this port (default: 8899)
  --tz <zone>     day-bucket in a specific IANA timezone (default: your local zone)
  --root <dir>    scan a custom root instead of the defaults (repeatable)
  --out <file>    write data.json and exit (no server)
  -h, --help      show this help

With no options it scans ~/.claude and (on macOS) ~/Library/Application Support/Claude,
prices every logged Claude Code / Desktop / Cowork / Agent-SDK call, then serves and opens
the dashboard. All local; no network, no telemetry.`);
    return;
  }
  const roots = args.roots.length ? args.roots : defaultRoots();
  console.error("claudemeter: scanning your local Claude usage (nothing leaves this machine)...");
  const { data, nFiles } = await scan(roots, args.tz);

  if (!data.parsed_messages) {
    console.error(`\nNo priced Claude usage found in:\n  ${roots.join("\n  ")}\n` +
      `Point it at your Claude data with --root, e.g. --root ~/.claude\n`);
    process.exit(1);
  }
  console.error(`Found ${data.parsed_messages.toLocaleString()} API calls across ${nFiles.toLocaleString()} files. ` +
    `Estimated cost $${data.total_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`);

  const dataJson = JSON.stringify(data);
  if (args.out) { writeFileSync(args.out, JSON.stringify(data, null, 2)); console.error(`Wrote ${args.out}`); return; }
  serve(readFileSync(join(PKG, "index.html"), "utf8"), dataJson, args.port, args.open);
}

main().catch(e => { console.error(e); process.exit(1); });
