import { notFound } from "next/navigation";
import { getGameDetail } from "@/lib/markets";
import { GameDetail } from "@/components/GameDetail";

export const dynamic = "force-dynamic";

export default async function GamePage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const detail = await getGameDetail(eventId);
  if (!detail) notFound();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <GameDetail game={detail.game} props={detail.props} logs={detail.logs} />
    </main>
  );
}
