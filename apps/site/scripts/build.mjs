/**
 * Prerender static marketing pages (no SPA). Safe for Cloudflare Pages.
 * Injects brand + legal placeholders from env — no secrets.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLANS,
  PUBLIC_PLAN_CODES,
  CURRENT_TERMS_VERSION,
  BRAND_NAME_FALLBACK,
} from "@waapi/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const dist = resolve(siteRoot, "dist");

const brand = (process.env.BRAND_NAME?.trim() || BRAND_NAME_FALLBACK);
const legalName = process.env.LEGAL_NAME?.trim() || "LEGAL_NAME";
const legalAddress = process.env.LEGAL_ADDRESS?.trim() || "[registered address]";
const merchantOfRecord = process.env.MERCHANT_OF_RECORD === "true";
const appUrl = (process.env.PUBLIC_APP_URL?.trim() || "https://app.example.com").replace(/\/$/, "");
const contactEmail = process.env.CONTACT_EMAIL?.trim() || "support@example.com";

const nav = [
  ["Home", "/"],
  ["Pricing", "/pricing/"],
  ["Docs", "/docs/"],
  ["Contact", "/contact/"],
];

const legalNav = [
  ["Terms", "/terms/"],
  ["Privacy", "/privacy/"],
  ["Refund", "/refund/"],
  ["AUP", "/aup/"],
];

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout({ title, path, body }) {
  const navHtml = nav
    .map(
      ([label, href]) =>
        `<a class="text-sm text-muted hover:text-accent ${path === href ? "text-accent" : ""}" href="${href}">${esc(label)}</a>`,
    )
    .join("\n          ");
  const legalHtml = legalNav
    .map(([label, href]) => `<a class="hover:text-accent" href="${href}">${esc(label)}</a>`)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · ${esc(brand)}</title>
  <meta name="description" content="${esc(brand)} — unofficial WhatsApp API for developers. Not affiliated with WhatsApp or Meta." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${path === "/" ? "/styles.css" : "/styles.css"}" />
</head>
<body class="min-h-screen flex flex-col">
  <header class="border-b border-line bg-panel/80 backdrop-blur">
    <div class="mx-auto flex max-w-5xl items-center justify-between gap-6 px-4 py-4">
      <a href="/" class="font-display text-2xl font-semibold tracking-tight text-ink">${esc(brand)}</a>
      <nav class="flex flex-wrap items-center gap-4">
          ${navHtml}
        <a class="rounded border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90" href="${esc(appUrl)}/signup">Open dashboard</a>
      </nav>
    </div>
  </header>
  <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-12">
${body}
  </main>
  <footer class="border-t border-line bg-panel">
    <div class="mx-auto max-w-5xl space-y-3 px-4 py-8 text-sm text-muted">
      <p><strong class="text-ink">${esc(brand)}</strong> is an unofficial product. It is <strong>not affiliated with WhatsApp or Meta</strong>. Using unofficial clients carries a <strong>ban risk</strong> for WhatsApp accounts.</p>
      <p>${legalHtml}</p>
      <p>© ${new Date().getFullYear()} ${esc(legalName)}. Terms version ${esc(CURRENT_TERMS_VERSION)}.</p>
    </div>
  </footer>
</body>
</html>
`;
}

function draftBanner() {
  return `<p class="mb-6 border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"><strong>DRAFT</strong> — for lawyer review. Not final legal advice.</p>`;
}

function pageHome() {
  return layout({
    title: "Home",
    path: "/",
    body: `
    <section class="max-w-2xl space-y-6">
      <h1 class="font-display text-5xl font-semibold tracking-tight">${esc(brand)}</h1>
      <p class="text-lg text-muted">HTTP API and dashboard for WhatsApp sessions — QR connect, send, signed webhooks. Built for closed-beta teams.</p>
      <div class="flex flex-wrap gap-3">
        <a class="rounded border border-accent bg-accent px-4 py-2 text-sm font-medium text-white" href="${esc(appUrl)}/signup">Start trial</a>
        <a class="rounded border border-line bg-panel px-4 py-2 text-sm" href="/docs/">Quickstart</a>
      </div>
    </section>`,
  });
}

function pagePricing() {
  const cards = PUBLIC_PLAN_CODES.map((code) => {
    const p = PLANS[code];
    return `<article class="border border-line bg-panel p-5">
      <h2 class="text-xl font-semibold">${esc(p.name)}</h2>
      <p class="mt-1 text-muted">${esc(p.priceLabel)}</p>
      <ul class="mt-4 space-y-1 text-sm text-muted">
        <li>${p.maxSessions} session${p.maxSessions === 1 ? "" : "s"}</li>
        <li>${p.sendsPerDay.toLocaleString()} sends / day</li>
      </ul>
    </article>`;
  }).join("\n");
  return layout({
    title: "Pricing",
    path: "/pricing/",
    body: `
    <h1 class="font-display text-4xl font-semibold">Pricing</h1>
    <p class="mt-2 max-w-xl text-muted">Trial includes ${PLANS.trial.maxSessions} session and ${PLANS.trial.sendsPerDay} sends/day for a short window. Paid plans: contact support to upgrade during closed beta.</p>
    <div class="mt-8 grid gap-4 sm:grid-cols-3">${cards}</div>`,
  });
}

function pageDocs() {
  return layout({
    title: "Docs",
    path: "/docs/",
    body: `
    <h1 class="font-display text-4xl font-semibold">Quickstart</h1>
    <ol class="mt-6 list-decimal space-y-3 pl-5 text-muted">
      <li>Create an account in the <a class="text-accent underline" href="${esc(appUrl)}/signup">dashboard</a> (invite code required in closed beta).</li>
      <li>Verify your email, then sign in.</li>
      <li>Create a session and scan the QR code with WhatsApp.</li>
      <li>Create a session API key and <code class="rounded bg-line/40 px-1">POST /api/v1/sessions/:id/send/text</code>.</li>
      <li>Register a webhook endpoint; deliveries are HMAC-signed.</li>
    </ol>
    <p class="mt-6 text-sm text-muted">Full OpenAPI lives on the API host at <code>/docs</code> when enabled.</p>`,
  });
}

function pageTerms() {
  const mor = merchantOfRecord
    ? `<p>Payment processing may be handled by a third-party merchant of record. Card data is never stored by ${esc(brand)}.</p>`
    : "";
  return layout({
    title: "Terms",
    path: "/terms/",
    body: `
    ${draftBanner()}
    <h1 class="font-display text-4xl font-semibold">Terms of Service</h1>
    <div class="prose mt-6 max-w-3xl space-y-4 text-muted">
      <p>These draft terms apply to ${esc(brand)}. Operator: <strong class="text-ink">${esc(legalName)}</strong>, ${esc(legalAddress)}.</p>
      <p>You must not use the service for spam, abuse, or unlawful activity. WhatsApp accounts used via unofficial clients may be banned — you accept that risk.</p>
      ${mor}
      <p>Version: ${esc(CURRENT_TERMS_VERSION)}.</p>
    </div>`,
  });
}

function pagePrivacy() {
  return layout({
    title: "Privacy",
    path: "/privacy/",
    body: `
    ${draftBanner()}
    <h1 class="font-display text-4xl font-semibold">Privacy Policy</h1>
    <div class="mt-6 max-w-3xl space-y-4 text-muted">
      <p>Operator: <strong class="text-ink">${esc(legalName)}</strong>, ${esc(legalAddress)}.</p>
      <p>We store account email, session metadata, encrypted auth material, and delivery logs needed to operate the API. Message bodies are not retained in application logs.</p>
      <p>Contact: <a class="text-accent underline" href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a>.</p>
    </div>`,
  });
}

function pageRefund() {
  return layout({
    title: "Refund",
    path: "/refund/",
    body: `
    ${draftBanner()}
    <h1 class="font-display text-4xl font-semibold">Refund Policy</h1>
    <div class="mt-6 max-w-3xl space-y-4 text-muted">
      <p>During closed beta, upgrades are arranged with support. Refund requests: email ${esc(contactEmail)}. Draft policy pending lawyer review for ${esc(legalName)}.</p>
    </div>`,
  });
}

function pageAup() {
  return layout({
    title: "Acceptable Use",
    path: "/aup/",
    body: `
    ${draftBanner()}
    <h1 class="font-display text-4xl font-semibold">Acceptable Use Policy</h1>
    <div class="mt-6 max-w-3xl space-y-4 text-muted">
      <p>No unsolicited bulk messaging, phishing, malware, or attempts to bypass rate limits or security controls. Violations may result in suspension without notice.</p>
    </div>`,
  });
}

function pageContact() {
  return layout({
    title: "Contact",
    path: "/contact/",
    body: `
    <h1 class="font-display text-4xl font-semibold">Contact</h1>
    <p class="mt-4 text-muted">Email <a class="text-accent underline" href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a> for billing, invites, and support.</p>`,
  });
}

const pages = {
  "index.html": pageHome(),
  "pricing/index.html": pagePricing(),
  "docs/index.html": pageDocs(),
  "terms/index.html": pageTerms(),
  "privacy/index.html": pagePrivacy(),
  "refund/index.html": pageRefund(),
  "aup/index.html": pageAup(),
  "contact/index.html": pageContact(),
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Write HTML first so Tailwind content scan can see class names
for (const [rel, html] of Object.entries(pages)) {
  const out = resolve(dist, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
}

const tw = resolve(siteRoot, "node_modules/tailwindcss/lib/cli.js");
execFileSync(
  process.execPath,
  [
    tw,
    "-i",
    resolve(siteRoot, "src/input.css"),
    "-o",
    resolve(dist, "styles.css"),
    "--minify",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);

writeFileSync(
  resolve(dist, "_redirects"),
  `/*    /index.html   200\n`,
  "utf8",
);

console.log(`Built ${Object.keys(pages).length} pages → ${dist}`);
