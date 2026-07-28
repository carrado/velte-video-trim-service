import { unlink } from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, R2_BUCKET } from "./r2Client.js";
import { trimFile } from "./ffmpegTrim.js";
import { pushToBunny } from "./bunnyPush.js";
import { updateJob } from "./jobStore.js";
import { env } from "./env.js";

async function downloadFromR2(key, destPath) {
  const res = await s3Client.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
  );
  await pipeline(res.Body, createWriteStream(destPath));
}

async function deleteFromR2(key) {
  // Best-effort — a failed cleanup here shouldn't fail the job the vendor
  // is waiting on. Worst case a stale object sits in R2 until it's noticed;
  // R2's free tier (10GB) has enough headroom that this isn't urgent.
  await s3Client
    .send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    .catch((err) => console.warn(`[processJob] R2 cleanup failed for ${key}:`, err));
}

// Runs after a tus upload finishes (see uploadsRouter.js's onUploadFinish).
// Fire-and-forget from the caller's perspective — the browser is polling
// GET /jobs/:id for status, not waiting on this promise directly.
//
// The original never touches local disk until THIS runs — it lives in R2
// from the moment the vendor's upload finishes until a worker slot picks it
// up here, which is what keeps local disk usage bounded by
// MAX_CONCURRENT_JOBS instead of by how many vendors are uploading at once.
export async function processJob({ jobId, r2Key, startS, endS, isMp4 }) {
  const inputPath = path.join(env.uploadDir, `${jobId}-input`);
  const outputPath = path.join(
    env.uploadDir,
    `${jobId}-trimmed.${isMp4 ? "mp4" : "webm"}`,
  );

  try {
    updateJob(jobId, { status: "trimming", progress: 10 });
    await downloadFromR2(r2Key, inputPath);

    updateJob(jobId, { progress: 20 });
    await trimFile({ inputPath, outputPath, startS, endS, isMp4 });

    updateJob(jobId, { status: "pushing", progress: 60 });
    const bunnyUrl = await pushToBunny({
      filePath: outputPath,
      title: "Product video",
      onProgress: (pct) =>
        updateJob(jobId, { progress: 60 + Math.round(pct * 40) }),
    });

    updateJob(jobId, { status: "done", progress: 100, bunnyUrl });
  } catch (err) {
    console.error(`[processJob ${jobId}] failed:`, err);
    updateJob(jobId, {
      status: "error",
      error: "Couldn't process this video on the server",
    });
  } finally {
    await Promise.allSettled([
      unlink(inputPath),
      unlink(outputPath),
      deleteFromR2(r2Key),
    ]);
  }
}
