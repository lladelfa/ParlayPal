import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ParlayPal | Quantitative Preset Parlays & +EV Telemetry",
  description:
    "Curated preset parlays and live devigged sportsbook telemetry powered by quantitative pricing models.",
};

const TYPOGRAPHY_STYLE = {
  "--font-space-grotesk": '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  "--font-outfit": '"Outfit", ui-sans-serif, system-ui, sans-serif',
  "--font-jetbrains-mono":
    '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
} as React.CSSProperties;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" style={TYPOGRAPHY_STYLE}>
      <body className="min-h-screen bg-surface-canvas text-text-primary font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
