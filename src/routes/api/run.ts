import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/run")({
  server: {
    handlers: {
      GET: async () => {
        const { cliStatus } = await import("@/lib/run-cli.server");
        const status = await cliStatus();
        return Response.json(status);
      },
      POST: async ({ request }) => {
        const form = await request.formData();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: Record<string, unknown>) => {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            };
            try {
              const { executeRun } = await import("@/lib/run-cli.server");
              await executeRun(form, send);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Run failed.";
              send({ type: "error", text: message });
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
