import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ParlayDrawerProvider } from "@/context/ParlayDrawerContext";
import { PresetFeed } from "./PresetFeed";
import { FALLBACK_PRESET_FEED } from "@/lib/presets";

function render(cards: typeof FALLBACK_PRESET_FEED.cards, reason?: Parameters<typeof PresetFeed>[0]["reason"]) {
  return renderToStaticMarkup(
    <ParlayDrawerProvider initialCandidates={[]}>
      <PresetFeed initialCards={cards} reason={reason} />
    </ParlayDrawerProvider>,
  );
}

describe("PresetFeed honest states", () => {
  it("shows the feed-unavailable empty state", () => {
    const html = render([], "feed_unavailable");
    expect(html).toContain("No live presets right now");
    expect(html).toContain("unavailable");
  });

  it("shows the no-qualifying-presets empty state", () => {
    const html = render([], "no_qualifying_presets");
    expect(html).toContain("No live presets right now");
    expect(html).toContain("quality bar");
  });

  it("labels sample data and hides the empty state", () => {
    const html = render(FALLBACK_PRESET_FEED.cards, "sample");
    expect(html).toContain("Sample data");
    expect(html).not.toContain("No live presets right now");
  });

  it("shows nothing extra for live cards", () => {
    const html = render(FALLBACK_PRESET_FEED.cards, "live");
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain("No live presets right now");
  });
});
