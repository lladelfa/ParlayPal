import Link from "next/link";

export default function GameNotFound() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 lg:px-8">
      <h1 className="font-display text-xl font-bold text-text-primary">Game not found</h1>
      <p className="mt-2 text-sm text-text-muted">
        This game is not on the slate. It may have started or been removed.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium text-accent-cyan hover:underline">
        ← Back to slate
      </Link>
    </main>
  );
}
