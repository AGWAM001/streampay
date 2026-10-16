import { Suspense } from "react";
import Dashboard from "@/components/Dashboard";

function PanelLoading() {
  return <p className="muted">Loading…</p>;
}

export default function Home() {
  return (
    <Suspense fallback={<PanelLoading />}>
      <Dashboard />
    </Suspense>
  );
}