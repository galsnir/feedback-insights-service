import "dotenv/config";
import { prisma } from "./lib/prisma";
import { InMemoryQueue } from "./queue/inMemoryQueue";
import { createAnalysisHandler, type AnalysisJob } from "./workers/analysisWorker";
import { startSweeper } from "./workers/sweeper";
import { buildLlmProvider } from "./llm/factory";
import { buildApp } from "./server";

async function main() {
  const provider = buildLlmProvider();
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? "10000");
  const sweeperIntervalMs = Number(process.env.SWEEPER_INTERVAL_MS ?? "30000");
  const sweeperStaleAfterMs = Number(process.env.SWEEPER_STALE_AFTER_MS ?? "120000");

  const queue = new InMemoryQueue<AnalysisJob>({ concurrency });
  const handler = createAnalysisHandler({ prisma, provider, timeoutMs });
  queue.registerHandler(handler);

  const sweeper = startSweeper({
    prisma,
    queue,
    intervalMs: sweeperIntervalMs,
    staleAfterMs: sweeperStaleAfterMs,
    onSweep: (rescued) => {
      // eslint-disable-next-line no-console
      console.log(`[sweeper] rescued ${rescued.length} stuck job(s)`);
    },
  });

  const app = buildApp({ prisma, queue });
  const port = Number(process.env.PORT ?? "3000");

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[server] listening on :${port} (llm=${provider.name}, concurrency=${concurrency}, sweeper=${sweeperIntervalMs}ms/${sweeperStaleAfterMs}ms)`,
    );
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down`);
    server.close();
    await sweeper.stop();
    await queue.shutdown();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[fatal]", err);
  process.exit(1);
});
