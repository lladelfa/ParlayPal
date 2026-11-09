import { getCuratedPresetFeed } from "@/lib/presets";
import { PresetFeed } from "@/components/PresetFeed";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const feed = await getCuratedPresetFeed();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Hero Header */}
      <header className="mb-8 flex flex-col justify-between gap-4 border-b border-border-hairline pb-6 sm:flex-row sm:items-center">
        <div>
          <span className="inline-block rounded bg-surface-card px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent-cyan border border-border-hairline">
            Quantitative Value Engine
          </span>
          <h1 className="mt-2 font-display text-[28px] leading-[36px] font-bold tracking-tight text-text-primary">
            Curated Preset Parlay Feed
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            High-conviction NFL &amp; NBA presets with rolling hit rates, weather alerts, and devigged fair value.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-lg bg-surface-module px-4 py-2.5 border border-border-hairline">
          <span className="h-2.5 w-2.5 rounded-full bg-accent-emerald animate-pulse" />
          <div className="text-xs">
            <p className="font-medium text-text-primary">Substrate Active</p>
            <p className="font-telemetry text-[11px] text-text-muted">
              45s TTL Hot Cache · Brent Power Devigged
            </p>
          </div>
        </div>
      </header>

      {/* Preset Parlays Feed Section */}
      <section>
        <PresetFeed initialCards={feed.cards} />
      </section>
    </main>
  );
}
