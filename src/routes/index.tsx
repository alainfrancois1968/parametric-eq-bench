import { createFileRoute } from "@tanstack/react-router";
import { EqBench } from "@/components/eq-bench";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <EqBench />;
}
