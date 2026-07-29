import { unlink } from "fs/promises";
import { createReadStream, statSync } from "fs";
import { PassThrough } from "stream";
import path from "path";
import {
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, R2_BUCKET } from "./r2Client.js";
import { trimFile, extractPosterFrame } from "./ffmpegTrim.js";
import { getJob, updateJob } from "./jobStore.js";
import { env } from "./env.js";

// How long ffmpeg has until this URL would expire — generous relative to
// ffmpegTrim's own STALL_TIMEOUT_MS, since a legitimately slow (not stuck)
// read over a weak connection should never lose the race against the URL
// itself going stale rather than against the stall guard.
const INPUT_URL_EXPIRY_S = 15 * 60;

// Exported for cancelRouter.js too — a cancel that lands after this job's
// already "done" deletes the same permanent keys this function would
// otherwise have cleaned up on a failure.
export async function deleteFromR2(key) {
  // Best-effort — a failed cleanup here shouldn't fail the job the vendor
  // is waiting on. Worst case a stale object sits in R2 until it's noticed;
  // R2's free tier (10GB) has enough headroom that this isn't urgent.
  await s3Client
    .send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    .catch((err) => console.warn(`[processJob] R2 cleanup failed for ${key}:`, err));
}

// Uploads the trimmed clip to its PERMANENT key (videos/ prefix — kept
// distinct from the scratch `${jobId}-original` key so a future lifecycle
// rule could expire abandoned originals without touching finished videos)
// and returns the public URL it's now served from. A plain single PUT, not
// multipart — the trimmed output is bounded by the 90s cap, not the
// original's size, so it's typically tens of MB at most.
//
// Progress is measured off the local *read* stream, not confirmed network
// delivery — close enough in practice because Node's stream backpressure
// throttles reads to roughly match how fast the S3 client is actually
// sending, so a slow upload shows a correspondingly slow progress climb
// rather than jumping to 100% the instant the file's read off disk.
async function pushToR2Public(filePath, key, contentType, onProgress) {
  const fileSize = statSync(filePath).size;
  const source = createReadStream(filePath);
  const counted = new PassThrough();
  let sent = 0;
  source.on("data", (chunk) => {
    sent += chunk.length;
    if (fileSize > 0) onProgress?.(sent / fileSize);
  });
  source.pipe(counted);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: counted,
      ContentLength: fileSize,
      ContentType: contentType,
    }),
  );
  onProgress?.(1);

  return `${env.r2PublicBaseUrl}/${key}`;
}

// Best-effort poster generation — a failed thumbnail shouldn't fail the job
// the vendor is waiting on. Written under the SAME key as the trimmed clip
// with a .jpg extension (videos/<jobId>.mp4 -> videos/<jobId>.jpg) — that
// naming convention is what bunnyStream.ts's videoPosterUrl() relies on to
// derive the poster URL from videoUrl alone, so nothing else (job status
// response, product schema) needs to carry a separate posterUrl field.
async function pushPosterBestEffort(jobId, trimmedPath, posterPath, totalS) {
  try {
    await extractPosterFrame({
      inputPath: trimmedPath,
      outputPath: posterPath,
      atS: Math.min(0.5, totalS / 2),
    });
    await pushToR2Public(posterPath, `videos/${jobId}.jpg`, "image/jpeg");
  } catch (err) {
    console.warn(`[processJob ${jobId}] poster generation failed:`, err);
  } finally {
    await unlink(posterPath).catch(() => {});
  }
}

// Runs after multipartRouter.js's /uploads/complete finishes the R2
// multipart upload. Fire-and-forget from the caller's perspective — the
// browser is polling GET /jobs/:id for status, not waiting on this promise
// directly.
//
// The original video never touches this service's local disk at all —
// ffmpeg reads it straight off R2 over HTTPS (see ffmpegTrim.js), so only
// the (much smaller) trimmed output ever gets written here, right before
// it's pushed back to R2 under its permanent key. Nothing here talks to
// Bunny anymore — R2 is both where the original scratch upload and the
// finished, publicly-served video live.
export async function processJob({ jobId, r2Key, startS, endS, isMp4 }) {
  const ext = isMp4 ? "mp4" : "webm";
  const outputPath = path.join(env.uploadDir, `${jobId}-trimmed.${ext}`);
  const posterPath = path.join(env.uploadDir, `${jobId}-poster.jpg`);
  const finalKey = `videos/${jobId}.${ext}`;

  try {
    updateJob(jobId, { status: "trimming", progress: 10 });

    const inputUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
      { expiresIn: INPUT_URL_EXPIRY_S },
    );

    await trimFile({
      inputUrl,
      outputPath,
      startS,
      endS,
      isMp4,
      onProgress: (pct) =>
        updateJob(jobId, { progress: 10 + Math.round(pct * 60) }),
    });

    updateJob(jobId, { status: "pushing", progress: 70 });
    const videoUrl = await pushToR2Public(
      outputPath,
      finalKey,
      isMp4 ? "video/mp4" : "video/webm",
      (pct) => updateJob(jobId, { progress: 70 + Math.round(pct * 30) }),
    );

    await pushPosterBestEffort(jobId, outputPath, posterPath, endS - startS);

    // The vendor may have cancelled while trim/push were running — too
    // late for cancelRouter.js to abort anything (the R2 multipart upload
    // was long since completed), so it just flagged this instead. Undo the
    // push rather than handing back a "done" job with a live videoUrl.
    if (getJob(jobId)?.cancelled) {
      await Promise.allSettled([
        deleteFromR2(finalKey),
        deleteFromR2(`videos/${jobId}.jpg`),
      ]);
      updateJob(jobId, { status: "cancelled" });
    } else {
      updateJob(jobId, { status: "done", progress: 100, videoUrl });
    }
  } catch (err) {
    console.error(`[processJob ${jobId}] failed:`, err);
    updateJob(jobId, {
      status: "error",
      error: "Couldn't process this video on the server",
    });
  } finally {
    await Promise.allSettled([unlink(outputPath), deleteFromR2(r2Key)]);
  }
}
