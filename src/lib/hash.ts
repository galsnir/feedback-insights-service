import { createHash } from "node:crypto";

// Stable SHA-256 over normalized content. Normalization is deliberately
// minimal -- we only trim leading/trailing whitespace so that "hi" and "hi\n"
// are treated as the same submission. Casing and internal whitespace ARE
// significant: "Bug" and "bug" are distinct feedback per the spec.
export function hashContent(content: string): string {
  return createHash("sha256").update(content.trim(), "utf8").digest("hex");
}
