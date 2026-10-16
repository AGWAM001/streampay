import { Suspense } from "react";
import Link from "next/link";
import StreamDetailClient from "@/components/StreamDetailClient";
import { readStream } from "@/lib/stellar-read";

async function StreamDetails({ id }: { id: string }) {
  try {
    const stream = await readStream(id);
    return <StreamDetailClient initialStream={stream} />;
  } catch (error) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="err">{error instanceof Error ? error.message : String(error)}</p>
        <Link href="/">← All streams</Link>
      </main>
    );
  }
}

export default async function StreamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <main className="wrap">
          <h1>Stream #{id}</h1>
          <p className="muted">Loading…</p>
        </main>
      }
    >
      <StreamDetails id={id} />
    </Suspense>
  );
}