export default function HomePage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col justify-between gap-4 border-b border-border-hairline pb-6 sm:flex-row sm:items-center">
        <div>
          <span className="inline-block rounded bg-surface-card px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent-cyan border border-border-hairline">
            Quantitative Value Engine
          </span>
          <h1 className="mt-2 font-display text-[28px] leading-[36px] font-bold tracking-tight text-text-primary">
            ParlayPal Command Feed
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Sub-second SSE telemetry and devigged NFL &amp; NBA preset parlays.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-lg bg-surface-module px-4 py-2.5 border border-border-hairline">
          <span className="h-2.5 w-2.5 rounded-full bg-accent-emerald" />
          <div className="text-xs">
            <p className="font-medium text-text-primary">Substrate Active</p>
            <p className="font-telemetry text-[11px] text-text-muted">
              /api/stream/odds
            </p>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <article className="rounded-xl bg-surface-card p-5 border border-border-hairline">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-accent-cyan">
              NFL · Pre-Match Substrate
            </span>
            <span className="rounded bg-surface-module px-2 py-0.5 font-telemetry text-xs font-bold text-accent-emerald border border-border-hairline">
              +4.2% EV
            </span>
          </div>
          <h2 className="mt-2 font-display text-[20px] leading-[26px] font-semibold text-text-primary">
            High-Conviction Substrate Ready
          </h2>
          <p className="mt-2 text-sm leading-5 text-text-muted">
            PostgreSQL 16 relational persistence and Redis 7.2 45-second hot cache connected.
          </p>
          <div className="mt-4 flex items-center justify-between border-t border-border-hairline pt-4">
            <span className="font-telemetry text-[11px] font-medium text-text-muted">
              8/10 (80.0%) L10
            </span>
            <span className="font-telemetry text-[18px] leading-[22px] font-bold text-accent-violet">
              +485
            </span>
          </div>
        </article>
      </section>
    </main>
  );
}
