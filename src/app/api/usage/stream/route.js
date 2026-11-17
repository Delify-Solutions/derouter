import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// Live view for the usage page: in-flight requests, the last few completed ones and the
// last failing provider. Everything here lives in memory, so a push is cheap.
//
// This stream used to re-run the full getUsageStats("all") on every "update" event (one
// per completed request, throttled to 150 ms) for every open tab, and the page threw all
// of it away except these four fields. On a busy installation that was a full-table scan
// several times a second, which froze the whole server. The aggregated numbers come from
// GET /api/usage/stats; this stream never computes them.
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, push: null };

  const stream = new ReadableStream({
    async start(controller) {
      const teardown = () => {
        state.closed = true;
        statsEmitter.off("update", state.push);
        statsEmitter.off("pending", state.push);
        clearInterval(state.keepalive);
      };

      state.push = async () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(await getActiveRequests())}\n\n`));
        } catch {
          teardown();
        }
      };

      await state.push();
      // The tab may have left (or the first push failed) while we awaited: register nothing.
      if (state.closed) return;

      statsEmitter.on("update", state.push);
      statsEmitter.on("pending", state.push);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          teardown();
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.push);
      statsEmitter.off("pending", state.push);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
