import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/result/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { openResult } = await import("@/lib/run-cli.server");
        const opened = await openResult(params.id);
        if (!opened) return new Response("Not found", { status: 404 });
        const encoded = encodeURIComponent(opened.filename);
        return new Response(opened.stream, {
          headers: {
            "Content-Type": "audio/wav",
            "Content-Disposition": `attachment; filename="${opened.filename.replaceAll('"', "")}"; filename*=UTF-8''${encoded}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
