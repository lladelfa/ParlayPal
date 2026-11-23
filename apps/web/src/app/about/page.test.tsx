import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AboutPage from "./page";

const markup = renderToStaticMarkup(<AboutPage />);

describe("About page", () => {
  it("covers every site section with an anchor id", () => {
    for (const id of [
      "what",
      "presets",
      "browser",
      "drawer",
      "quickpick",
      "tracking",
      "score",
      "hit-rates",
      "ev",
      "disclaimer",
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }
  });

  it("states the implemented Hybrid Value Score formula", () => {
    expect(markup).toContain("Hybrid Value Score");
    expect(markup).toContain("60%");
    expect(markup).toContain("40%");
    expect(markup).toContain("0 to 100");
    expect(markup).toContain("EV x 10 + 50");
  });

  it("explains missing data, Limited history, Under hits and the 10% guard", () => {
    expect(markup).toContain("Limited history");
    expect(markup).toContain("EV component alone");
    expect(markup).toContain("below the line");
    expect(markup).toContain("10%");
    expect(markup).toContain("L5");
    expect(markup).toContain("Season");
  });

  it("says it is not betting advice and links home", () => {
    expect(markup.toLowerCase()).toContain("not betting advice");
    expect(markup).toContain('href="/"');
  });
});
