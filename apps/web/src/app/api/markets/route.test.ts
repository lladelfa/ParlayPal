import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/markets", () => {
  it("returns 200 with complete market feed", async () => {
    const req = new Request("http://localhost:3000/api/markets");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("props");
    expect(data).toHaveProperty("games");
    expect(Array.isArray(data.props)).toBe(true);
    expect(data.props.length).toBeGreaterThan(0);
  });

  it("filters by sport and market query parameters", async () => {
    const req = new Request("http://localhost:3000/api/markets?sport=nba&market=player_points");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.props.every((p: { sportKey: string; marketKey: string }) => p.sportKey === "nba" && p.marketKey === "player_points")).toBe(true);
  });

  it("filters by search query", async () => {
    const req = new Request("http://localhost:3000/api/markets?q=curry");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.props.length).toBe(1);
    expect(data.props[0].playerName).toBe("Stephen Curry");
  });
});
