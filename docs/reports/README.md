# Engineering reports

| Document | HTML | PDF |
|----------|------|-----|
| **Project report** — status, WPs, architecture, gaps | [waapi-project-report.html](./waapi-project-report.html) | [waapi-project-report.pdf](./waapi-project-report.pdf) |
| **Source code documentation** — folder tree, modules, migrations, tests | [waapi-source-code-documentation.html](./waapi-source-code-documentation.html) | [waapi-source-code-documentation.pdf](./waapi-source-code-documentation.pdf) |

Regenerate PDFs (Chrome/Edge required):

```bash
node docs/reports/render-pdfs.mjs
```

These are public engineering handoff docs. They contain no secrets.

**Private (not in this repo):** security-pass triage and Claude Phase-4 handoff
were moved out of the public tree to a local private ops pack
(`waapi-private-ops/` sibling directory on the maintainer machine). Do not
re-commit those files here.
