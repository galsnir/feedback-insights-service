import express, { type Express } from "express";
import type { PrismaClient } from "@prisma/client";
import type { InMemoryQueue } from "./queue/inMemoryQueue";
import type { AnalysisJob } from "./workers/analysisWorker";
import { FeedbackService } from "./services/feedbackService";
import { buildFeedbackRouter } from "./routes/feedback";

export interface AppDeps {
  prisma: PrismaClient;
  queue: InMemoryQueue<AnalysisJob>;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      queue: { size: deps.queue.size(), inFlight: deps.queue.inFlight() },
    });
  });

  const service = new FeedbackService({ prisma: deps.prisma, queue: deps.queue });
  app.use("/feedback", buildFeedbackRouter(service));

  // Centralised error handler -- last-resort safety net.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[unhandled]", err);
    res.status(500).json({ error: "internal_error", message: err.message });
  });

  return app;
}
