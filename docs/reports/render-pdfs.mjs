/**
 * Render HTML reports to PDF via Chrome/Edge headless.
 * Usage: node docs/reports/render-pdfs.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const chrome = chromeCandidates.find((p) => existsSync(p));
if (!chrome) {
  console.error("Chrome/Edge not found. Set CHROME_PATH.");
  process.exit(1);
}

const jobs = [
  ["waapi-project-report.html", "waapi-project-report.pdf"],
  ["waapi-source-code-documentation.html", "waapi-source-code-documentation.pdf"],
];

for (const [htmlName, pdfName] of jobs) {
  const html = resolve(dir, htmlName);
  const pdf = resolve(dir, pdfName);
  const url = pathToFileURL(html).href;
  console.log(`Rendering ${htmlName} → ${pdfName}`);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdf}`,
    url,
  ];
  const r = spawnSync(chrome, args, { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(pdf)) {
    console.error(r.stderr || r.stdout || "print failed");
    // Fallback older flag
    execFileSync(chrome, ["--headless", "--disable-gpu", `--print-to-pdf=${pdf}`, url], {
      stdio: "inherit",
    });
  }
  if (!existsSync(pdf)) {
    console.error(`Failed to create ${pdf}`);
    process.exit(1);
  }
  console.log(`OK ${pdf}`);
}
