import type { MarketPropRow } from "@/types/market";

export type SortField =
  | "player"
  | "team"
  | "market"
  | "line"
  | "odds"
  | "ev"
  | "hitRate"
  | "score";
export type SortDir = "asc" | "desc";
export interface SortState {
  field: SortField;
  dir: SortDir;
}

export const SORT_FIELDS: { field: SortField; label: string }[] = [
  { field: "player", label: "Player" },
  { field: "team", label: "Team" },
  { field: "market", label: "Market" },
  { field: "line", label: "Line" },
  { field: "odds", label: "Odds" },
  { field: "ev", label: "EV" },
  { field: "hitRate", label: "Hit Rate" },
  { field: "score", label: "Score" },
];

export const DEFAULT_SORT: SortState = { field: "score", dir: "desc" };

const TEXT_FIELDS: ReadonlySet<SortField> = new Set(["player", "team", "market"]);

/** Direction a field starts in when first chosen: A-Z for text, best-first for numbers. */
export function defaultDir(field: SortField): SortDir {
  return TEXT_FIELDS.has(field) ? "asc" : "desc";
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function sortValue(row: MarketPropRow, field: SortField): string | number | null {
  switch (field) {
    case "player":
      return row.playerName.toLowerCase();
    case "team":
      return row.teamAbbreviation.toLowerCase();
    case "market":
      return (row.marketDisplay || row.marketLabel || row.marketKey).toLowerCase();
    case "line":
      return num(row.lineValue);
    case "odds":
      return num(row.offeredDecimalOdds);
    case "ev":
      return num(row.guardedEv);
    case "hitRate":
      return num(row.hitRateL10);
    case "score":
      return num(row.hybridValueScore);
  }
}

/** Returns a sorted copy. Missing values sort last in both directions; ties keep feed order. */
export function sortMarketProps(props: MarketPropRow[], sort: SortState): MarketPropRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return props
    .map((row, index) => ({ row, index, value: sortValue(row, sort.field) }))
    .sort((x, y) => {
      if (x.value === null && y.value === null) return x.index - y.index;
      if (x.value === null) return 1;
      if (y.value === null) return -1;
      if (x.value < y.value) return -sign;
      if (x.value > y.value) return sign;
      return x.index - y.index;
    })
    .map((entry) => entry.row);
}

/** Reads `?sort=&dir=`; unknown field falls back to the default, a bad dir to the field's default. */
export function parseSortParam(search: string): SortState {
  const params = new URLSearchParams(search);
  const field = SORT_FIELDS.find((f) => f.field === params.get("sort"))?.field;
  if (!field) return DEFAULT_SORT;
  const dir = params.get("dir");
  return { field, dir: dir === "asc" || dir === "desc" ? dir : defaultDir(field) };
}

/** Sets or removes `sort`/`dir`, keeping other params and the hash. Default sort leaves the URL clean. */
export function withSortParam(
  pathname: string,
  search: string,
  hash: string,
  sort: SortState,
): string {
  const params = new URLSearchParams(search);
  if (sort.field === DEFAULT_SORT.field && sort.dir === DEFAULT_SORT.dir) {
    params.delete("sort");
    params.delete("dir");
  } else {
    params.set("sort", sort.field);
    params.set("dir", sort.dir);
  }
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}
