// Application-level enum for Feedback.status. Stored as TEXT in SQLite.
export const FeedbackStatus = {
  RECEIVED: "RECEIVED",
  ANALYZING: "ANALYZING",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

export type FeedbackStatus = (typeof FeedbackStatus)[keyof typeof FeedbackStatus];

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && value in FeedbackStatus;
}
