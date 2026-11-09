---
title: "ParlayPal UX Design Contract — DESIGN.md"
status: final
created: "2026-11-08"
updated: "2026-11-08"
stitch_project_id: "12734826812446124798"
stitch_screen_id: "575e43f4763945ceba9f618cc0e77ff8"
---

# ParlayPal — Visual Identity & Design System Specification

## 1. Brand Personality & Synthesis
ParlayPal blends the **tactile, dopamine-rich, social enthusiasm of Sleeper** with the **clinical, quantitative telemetry of Sofascore**.
- **From Sleeper:** High-contrast dark mode, rounded card geometry, vibrant neon energy (Electric Cyan, Violet), tactile card interactions, and an unintrusive persistent betslip dock.
- **From Sofascore:** Rigorous statistical visualization, 5-game rolling form indicators (`🟢🟢🟢🔴🟢`), head-to-head metrics, weather threat indicators, and fixed-width tabular typography that never shifts during live odds ticks.

---

## 2. Color Palette & Semantics

| Token | Hex | Role | Usage |
| :--- | :--- | :--- | :--- |
| **`canvas`** | `#0a0e17` | Canvas Base | Deep slate foundation; absorbs eye strain during long research sessions. |
| **`surface`** | `#0f131c` | Surface / Default Container | Module headers, side navigation, search backgrounds. |
| **`card-surface`** | `#121b2d` | Card & Tile Surface | Preset parlay cards, matchup rows, betting blocks. |
| **`border-hairline`**| `#1e293b` | Structural Border | 1px crisp dividers, table lines, module containment. |
| **`primary-cyan`** | `#06b6d4` | Real-Time Interactive / Brand | Primary buttons, active odds pills, lightning accent, glow borders. |
| **`secondary-violet`**| `#6366f1`| Parlay Multiplier & Models | Secondary highlights, parlay multiplier pills, correlation badges. |
| **`mint-emerald`** | `#10b981` | Positive Edge & Win Form | `+EV` pills, winning form dots (`🟢`), best sportsbook price badge. |
| **`amber-warning`** | `#f59e0b` | Situational / Weather Threat| Wind $\ge 15\text{ mph}$, freezing temps, rain/snow alerts, questionable injury. |
| **`rose-danger`** | `#f43f5e` | Negative / Outlier Guard | `SUSPECT_STALE_LINE` alerts, losing form dots (`🔴`), locked lines. |
| **`text-dominant`** | `#f8fafc` | High-Contrast Typography | Player names, primary headers, execution odds. |
| **`text-muted`** | `#94a3b8` | Supporting Metadata | Matchup text, team codes, market labels, volume indicators. |

---

## 3. Typography Hierarchy

| Style | Font Family | Size / Line Height | Weight | Role |
| :--- | :--- | :--- | :--- | :--- |
| **Display / Header** | Space Grotesk | `28px / 36px` | 700 (Bold) | Page hero titles, major preset card headers. |
| **Section Title** | Space Grotesk | `20px / 26px` | 600 (Semibold) | Card titles, drawer headers, league names. |
| **Body Primary** | Outfit | `14px / 20px` | 400 (Regular) | Conviction micro-copy, matchup descriptions. |
| **Odds / Telemetry**| JetBrains Mono| `18px / 22px` | 700 (Bold) | Combined parlay odds (`+485`), stake amounts, EV%. |
| **Form / Micro** | JetBrains Mono| `11px / 14px` | 500 (Medium) | Hit-rate badges (`8/10 L10`), latency readouts (`18ms`). |
| **Category Pill** | Outfit | `11px / 14px` | 600 (Semibold) | Uppercase badges (`NFL ANYTIME TOUCHDOWN`). |

---

## 4. Key UI Components

### 4.1 Curated Preset Parlay Card
- **Header:** Sport icon, preset title (e.g., *"The Red Zone Express"*), combined American payout badge (`+485`) with glowing cyan border, and `+4.1% EV` mint badge.
- **Leg Item Anatomy:**
  - Player headshot (48x48px, rounded 8px) + team code badge (`BAL`).
  - Player name + matchup (`BAL @ PIT • RB`) + prop market pill (`Anytime TD`).
  - Conviction micro-copy: 1-line plain-English rationale.
  - Sofascore Form Indicator: 5 rounded squares (3px radius) colored green for hit, red for miss, followed by `8/10 L10 hit rate` label.
  - Context Badge: Yellow warning pill for outdoor weather or dome icon.
  - Sharp price pill (`-135`) with checkmark icon.
- **Card Footer:** Secondary action (`Customize Legs`) + glowing Cyan primary CTA (`Open in Sportsbook via QuickPick`).

### 4.2 Persistent Sticky Parlay Drawer (Slip Engine)
- **Position:** Right-hand fixed rail on desktop (360px wide); sticky bottom bar with swipe-up handle on mobile.
- **Header:** Active legs count, total potential payout (`$100 -> $585.00`).
- **Legs List:** Mini-cards with remove (`✕`) and swap actions.
- **Lineshopper Widget:** Live price matrix comparing payout across FanDuel, DraftKings, BetMGM, and Caesars with the highest-paying book highlighted in Emerald Green with a `Best Value ⭐` star.
- **Primary CTA:** Glowing 1-tap checkout trigger: *"1-Tap Launch via QuickPick"*.
