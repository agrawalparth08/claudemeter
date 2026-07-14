/* Inline etl.js into index.html between the ETL markers, so the shipped
 * index.html is fully self-contained (works from file://, no external fetch, no
 * modules). Edit etl.js, then run `node build.mjs` (or `npm run build`).
 *
 * The browser and the node parity test share etl.js as the one source of truth;
 * this step is the only thing that copies it into the HTML. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url));
const START = "// ==CLAUDEMETER_ETL_START==";
const END = "// ==CLAUDEMETER_ETL_END==";

const etlSrc = readFileSync(join(REPO, "etl.js"), "utf8")
  .replace(/^export\s+/gm, "");           // strip ESM `export ` -> plain declarations

const html = readFileSync(join(REPO, "index.html"), "utf8");
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error("build.mjs: could not find ETL markers in index.html");
  process.exit(1);
}
const banner = START + " (auto-generated from etl.js by build.mjs; DO NOT EDIT here; edit etl.js then run `node build.mjs`)\n";
const out = html.slice(0, i) + banner + etlSrc.trimEnd() + "\n" + html.slice(j);
writeFileSync(join(REPO, "index.html"), out);

const lines = etlSrc.split("\n").length;
console.log(`build.mjs: inlined etl.js (${lines} lines) into index.html between markers.`);
