import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { s3Client, R2_BUCKET } from "./r2Client.js";
import { verifyUploadToken } from "./auth.js";
import { getJob, updateJob } from "./jobStore.js";
import { deleteFromR2 } from "./processJob.js";

// POST /uploads/cancel — the vendor hit Cancel on the floating progress bar
// (see videoTrim.ts). Always responds { ok: true }: this is cleanup, not
// something the browser can retry usefully, and the job may legitimately
// already be gone (swept by jobStore.js's TTL, or never existed if the
// vendor cancelled before /uploads/init even returned).
export async function cancelUpload(req, res) {
  let jobId;
  try {
    ({ jobId } = await verifyUploadToken(req.headers.authorization));
  } catch {
    return res.status(401).json({ error: "Invalid or missing token" });
  }

  const job = getJob(jobId);
  if (!job) return res.json({ ok: true });

  if (job.status === "uploading" && job.uploadId && job.r2Key) {
    // Parts are still (or were) landing directly from the browser — this
    // releases the whole multipart upload in one call rather than this
    // service needing to know which parts actually made it.
    await s3Client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: job.r2Key,
          UploadId: job.uploadId,
        }),
      )
      .catch((err) =>
        console.warn(`[cancelRouter] abort multipart failed for ${jobId}:`, err),
      );
    updateJob(jobId, { status: "cancelled" });
  } else if (job.status === "done" && job.videoUrl) {
    // processJob.js already pushed the finished clip (+ poster) under its
    // permanent key before this cancel arrived — delete them directly
    // instead of just flagging, since nothing's still running to act on
    // the flag.
    const ext = job.isMp4 ? "mp4" : "webm";
    await Promise.allSettled([
      deleteFromR2(`videos/${jobId}.${ext}`),
      deleteFromR2(`videos/${jobId}.jpg`),
    ]);
    updateJob(jobId, { status: "cancelled", videoUrl: null });
  } else {
    // queued / trimming / pushing — processJob.js is mid-flight; it checks
    // this flag itself right before marking the job "done".
    updateJob(jobId, { cancelled: true });
  }

  res.json({ ok: true });
}
