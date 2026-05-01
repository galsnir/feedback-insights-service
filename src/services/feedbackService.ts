import { Prisma, type PrismaClient } from "@prisma/client";
import type { InMemoryQueue } from "../queue/inMemoryQueue";
import type { AnalysisJob } from "../workers/analysisWorker";
import { hashContent } from "../lib/hash";
import { FeedbackStatus, isFeedbackStatus } from "../lib/status";

const feedbackInclude = {
  analysis: { include: { featureRequests: true } },
} satisfies Prisma.FeedbackInclude;

type FeedbackWithAnalysis = Prisma.FeedbackGetPayload<{ include: typeof feedbackInclude }>;

export interface FeedbackServiceDeps {
  prisma: PrismaClient;
  queue: InMemoryQueue<AnalysisJob>;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export class FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}

  public async create(content: string): Promise<{ id: string; status: FeedbackStatus }> {
    const trimmed = content.trim();
    const contentHash = hashContent(trimmed);
    const created = await this.deps.prisma.feedback.create({
      data: {
        content: trimmed,
        contentHash,
        status: FeedbackStatus.RECEIVED,
      },
      select: { id: true, status: true },
    });
    this.deps.queue.enqueue({ feedbackId: created.id });
    return { id: created.id, status: created.status as FeedbackStatus };
  }

  public async list(opts: { status?: string; limit?: number; cursor?: string }) {
    const limit = clampLimit(opts.limit);
    const where = opts.status && isFeedbackStatus(opts.status) ? { status: opts.status } : {};
    const items = await this.deps.prisma.feedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: feedbackInclude,
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page.map(serializeFeedback),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }

  public async getById(id: string) {
    const found = await this.deps.prisma.feedback.findUnique({
      where: { id },
      include: feedbackInclude,
    });
    return found ? serializeFeedback(found) : null;
  }

  public async retry(id: string): Promise<
    | { ok: true; status: FeedbackStatus }
    | { ok: false; reason: "not_found" | "not_failed"; currentStatus?: string }
  > {
    const current = await this.deps.prisma.feedback.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status !== FeedbackStatus.FAILED) {
      return { ok: false, reason: "not_failed", currentStatus: current.status };
    }
    const updated = await this.deps.prisma.feedback.updateMany({
      where: { id, status: FeedbackStatus.FAILED },
      data: { status: FeedbackStatus.RECEIVED, lastError: null },
    });
    if (updated.count === 0) {
      // Lost a race with another retry. Best to surface the new state.
      const after = await this.deps.prisma.feedback.findUnique({
        where: { id },
        select: { status: true },
      });
      return { ok: false, reason: "not_failed", currentStatus: after?.status };
    }
    this.deps.queue.enqueue({ feedbackId: id });
    return { ok: true, status: FeedbackStatus.RECEIVED };
  }
}

function clampLimit(raw: number | undefined): number {
  if (!raw || Number.isNaN(raw)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(raw)), MAX_LIMIT);
}

// Boundary translation: snake_case for the JSON wire format (matches the
// challenge spec's field naming and the LLM output schema's existing
// snake_case style), camelCase internally per JS convention.
function serializeFeedback(f: FeedbackWithAnalysis) {
  return {
    id: f.id,
    content: f.content,
    status: f.status,
    attempts: f.attempts,
    last_error: f.lastError,
    raw_response: f.rawResponse,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
    analysis: f.analysis
      ? {
          id: f.analysis.id,
          sentiment: f.analysis.sentiment,
          actionable_insight: f.analysis.actionableInsight,
          feature_requests: f.analysis.featureRequests.map((fr) => ({
            title: fr.title,
            confidence: fr.confidence,
          })),
          raw_response: f.analysis.rawResponse,
          created_at: f.analysis.createdAt.toISOString(),
        }
      : null,
  };
}
