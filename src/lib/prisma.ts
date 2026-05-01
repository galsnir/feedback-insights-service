import { PrismaClient } from "@prisma/client";

// Singleton client. Tests can swap DATABASE_URL via env before importing this.
export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === "true" ? ["query", "warn", "error"] : ["warn", "error"],
});
