import { createHash } from "node:crypto";

/**
 * Derive a stable cache namespace for an adapter-owned subchunk.
 *
 * A durable TTS job gives the adapter the parent job id and parent chunk
 * index. When that parent chunk is split into several sidecar requests, the
 * child indexes must start at zero inside a namespace unique to that parent.
 * Otherwise parent chunk 1 can reuse parent chunk 0's cached child 1, 2, ...
 * because the Python sidecars cache by `job_id/chunk_index`.
 */
export function deriveSubchunkCacheJobId(
  jobId: string | undefined,
  parentChunkIndex: number | undefined,
): string | undefined {
  if (!jobId || parentChunkIndex === undefined) return jobId;

  const digest = createHash("sha256")
    .update(`local-tts-sidecar:${jobId}:${parentChunkIndex}`, "utf8")
    .digest("hex");

  // The sidecars validate job_id as a UUID. Mark the digest as a UUIDv5-like
  // value so the derived namespace remains valid without adding a dependency.
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13)}`;
  const variantNibble = (Number.parseInt(versioned[16]!, 16) & 0x3) | 0x8;
  const withVariant = `${versioned.slice(0, 16)}${variantNibble.toString(16)}${versioned.slice(17)}`;
  return `${withVariant.slice(0, 8)}-${withVariant.slice(8, 12)}-${withVariant.slice(12, 16)}-${withVariant.slice(16, 20)}-${withVariant.slice(20, 32)}`;
}
