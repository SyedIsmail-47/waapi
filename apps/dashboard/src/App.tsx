import { BRAND_NAME_FALLBACK } from "@waapi/shared";

/** Phase 1 stub. Full dashboard in Phase 3. */
export function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-semibold">{BRAND_NAME_FALLBACK}</h1>
        <p className="text-slate-400 text-sm">
          Dashboard stub (Phase 1). Session engine runs in the worker.
        </p>
      </div>
    </main>
  );
}
