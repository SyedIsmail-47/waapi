import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const dir = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(resolve(dir, "claude-handoff-phase4.md"), "utf8");
const esc = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>waapi — Claude handoff Phase 4</title>
<link rel="stylesheet" href="print.css"/>
<style>
  body { font-family: "Segoe UI", sans-serif; font-size: 10pt; }
  pre.handoff { white-space: pre-wrap; font-family: Consolas, monospace; font-size: 8.5pt; line-height: 1.35; }
</style></head><body>
<h1>Claude handoff — Phase 4</h1>
<pre class="handoff">${esc(md)}</pre>
</body></html>`;
const htmlPath = resolve(dir, "claude-handoff-phase4.html");
const pdfPath = resolve(dir, "claude-handoff-phase4.pdf");
writeFileSync(htmlPath, html, "utf8");

const chrome = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => p && existsSync(p));
if (!chrome) {
  console.error("No Chrome/Edge");
  process.exit(1);
}
spawnSync(
  chrome,
  ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href],
  { encoding: "utf8" },
);
console.log("OK", pdfPath);
