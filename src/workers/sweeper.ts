import type { PrismaClient } from "@prisma/client";
import type { InMemoryQueue } from "../queue/inMemoryQueue";
import type { AnalysisJob } from "./analysisWorker";
import { FeedbackStatus } from "../lib/status";

// The sweeper recovers Feedback rows stuck in ANALYZING because the worker
// process crashed (or was killed) mid-job. The in-memory queue is lossy by
// design; this is the recovery mechanism for that loss.
//
// On each tick:
//   1. Atomically flip ANALYZING -> RECEIVED for rows whose updatedAt is older
//      than the staleness threshold. The updateMany acts as a CAS so a row a
//      live worker is currently touching cannot be hijacked (a live worker
//      bumps updatedAt on every transition).
//   2. Re-enqueue the affected ids.
//
// Tradeoff: we use updatedAt as a heartbeat. A worker that hangs WITHOUT
// touching the row will eventually be reaped, which is the desired behaviour.
// A worker that legitimately takes longer than the threshold will be
// double-processed, but the analysisWorker's guarded transitions (the
// claim-step requires status=RECEIVED) make double-processing a no-op for
// whichever attempt loses the race. Set staleAfterMs comfortably above the
// LLM timeout to keep this rare.

export interface SweeperOptions {
  prisma: PrismaClient;
  queue: InMemoryQueue<AnalysisJob>;
  intervalMs: number;
  staleAfterMs: number;
  onSweep?: (rescued: string[]) => void;
}

export interface SweeperHandle {
  stop: () => Promise<void>;
  // Exposed for tests so they can force a tick without waiting for the timer.
  tickNow: () => Promise<string[]>;
}

export function startSweeper(opts: SweeperOptions): SweeperHandle {
  const { prisma, queue, intervalMs, staleAfterMs, onSweep } = opts;

  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const tick = async (): Promise<string[]> => {
    if (stopped) return [];
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stuck = await prisma.feedback.findMany({
      where: { status: FeedbackStatus.ANALYZING, updatedAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stuck.length === 0) return [];

    const ids = stuck.map((r) => r.id);
    const reset = await prisma.feedback.updateMany({
      where: {
        id: { in: ids },
        status: FeedbackStatus.ANALYZING,
        updatedAt: { lt: cutoff },
      },
      data: { status: FeedbackStatus.RECEIVED },
    });

    if (reset.count === 0) return [];

    // Re-enqueue. We re-fetch the ids that actually flipped so we don't
    // enqueue rows that a concurrent worker bumped between our findMany and
    // updateMany.
    const rescued = await prisma.feedback.findMany({
      where: { id: { in: ids }, status: FeedbackStatus.RECEIVED },
      select: { id: true },
    });
    for (const row of rescued) {
      try {
        queue.enqueue({ feedbackId: row.id });
      } catch {
        // Queue is draining (process shutting down). Leave the row in
        // RECEIVED so the next process picks it up.
      }
    }

    const rescuedIds = rescued.map((r) => r.id);
    onSweep?.(rescuedIds);
    return rescuedIds;
  };

  const safeTick = () => {
    if (stopped || inFlight) return;
    inFlight = tick()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[sweeper] tick failed", err);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(safeTick, intervalMs);
  timer.unref?.(); // never block process exit

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
    async tickNow() {
      const result = await tick();
      return result;
    },
  };
}
