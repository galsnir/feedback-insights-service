import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { FeedbackService } from "../services/feedbackService";

const CreateBody = z.object({
  content: z.string().min(1).max(5000),
});

const ListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
});

export function buildFeedbackRouter(service: FeedbackService): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_body",
        details: parsed.error.issues,
      });
    }
    const { id, status } = await service.create(parsed.data.content);
    return res.status(201).json({ id, status });
  });

  router.get("/", async (req: Request, res: Response) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_query",
        details: parsed.error.issues,
      });
    }
    const result = await service.list(parsed.data);
    return res.json(result);
  });

  router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
    const found = await service.getById(req.params.id);
    if (!found) return res.status(404).json({ error: "not_found" });
    return res.json(found);
  });

  router.post("/:id/retry", async (req: Request<{ id: string }>, res: Response) => {
    const result = await service.retry(req.params.id);
    if (result.ok) {
      return res.status(202).json({ id: req.params.id, status: result.status });
    }
    if (result.reason === "not_found") {
      return res.status(404).json({ error: "not_found" });
    }
    return res.status(409).json({
      error: "not_retriable",
      message: "Only feedback in FAILED state can be retried",
      currentStatus: result.currentStatus,
    });
  });

  return router;
}
