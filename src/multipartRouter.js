import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, R2_BUCKET } from "./r2Client.js";
import { verifyUploadToken } from "./auth.js";
import { createJob, updateJob, getJob } from "./jobStore.js";
import { processJob } from "./processJob.js";
import { enqueue } from "./queue.js";

// Replaces the old tus + @tus/s3-store upload path. That relayed every
// byte through a single sequential stream terminating at this service
// (Express receiving a tus PATCH, @tus/s3-store re-uploading it to R2
// internally) — fine for resumability, bad for throughput: one TCP stream
// can't fill the available bandwidth on most real connections, especially
// higher-latency mobile ones. This instead hands the browser presigned
// per-part PUT URLs and lets it PUT several parts to R2 directly and
// concurrently — this service never sees the video bytes at all, in
// either direction.
//
// 16MB — comfortably above R2/S3's 5MB-per-part minimum (every part but
// the last must clear it), small enough that a single failed part is a
// cheap, quick retry rather than resending a huge chunk, and few enough
// parts (~128 for the 2GB ceiling — see bunnyStream.ts's MAX_VIDEO_BYTES)
// that minting every part's presigned URL up front in one /uploads/init
// response is still fast.
const PART_SIZE = 16 * 1024 * 1024;
// Same window as the job's own JWT (see trim-auth/route.ts) — a slow
// connection uploading a full 2GB original shouldn't have its last part's
// URL go stale before it's finally sent.
const PART_URL_EXPIRY_S = 4 * 60 * 60;

async function authorize(req) {
  return verifyUploadToken(req.headers.authorization);
}

// POST /uploads/init — called once, right when "Trim & Continue" is
// clicked, before any bytes move. Creates the R2 multipart upload and
// returns a presigned PUT URL per part; the browser uploads parts directly
// against those URLs (see videoTrim.ts), never through this service.
export async function initUpload(req, res) {
  let jobId;
  try {
    ({ jobId } = await authorize(req));
  } catch {
    return res.status(401).json({ error: "Invalid or missing token" });
  }

  const { contentType, fileSize, startS, endS } = req.body ?? {};
  if (!(fileSize > 0)) {
    return res.status(400).json({ error: "fileSize is required" });
  }
  if (!(Number(endS) > Number(startS ?? 0))) {
    return res
      .status(400)
      .json({ error: "endS must be greater than startS" });
  }

  const r2Key = `${jobId}-original`;
  const isMp4 = contentType !== "video/webm";

  let uploadId;
  let parts;
  try {
    const created = await s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        ContentType: contentType || "video/mp4",
      }),
    );
    uploadId = created.UploadId;

    const numParts = Math.max(1, Math.ceil(fileSize / PART_SIZE));
    parts = await Promise.all(
      Array.from({ length: numParts }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await getSignedUrl(
            s3Client,
            new UploadPartCommand({
              Bucket: R2_BUCKET,
              Key: r2Key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: PART_URL_EXPIRY_S },
          ),
        }),
      ),
    );
  } catch (err) {
    console.error(`[multipartRouter] init failed for job ${jobId}:`, err);
    return res.status(502).json({ error: "Couldn't start the upload" });
  }

  createJob(jobId, {
    r2Key,
    uploadId,
    startS: Number(startS) || 0,
    endS: Number(endS),
    isMp4,
  });

  res.json({ r2Key, partSize: PART_SIZE, parts });
}

// POST /uploads/complete — called once every part has PUT successfully.
// r2Key/uploadId/startS/endS/isMp4 all come back out of the job this
// service created at /uploads/init time (keyed by the token's jobId), not
// from the request body — only the per-part ETags the browser collected
// off each PUT response have to come from the client, since R2 is the only
// other party that knows them.
export async function completeUpload(req, res) {
  let jobId;
  try {
    ({ jobId } = await authorize(req));
  } catch {
    return res.status(401).json({ error: "Invalid or missing token" });
  }

  const job = getJob(jobId);
  if (!job?.r2Key || !job?.uploadId) {
    return res
      .status(404)
      .json({ error: "No upload in progress for this job" });
  }

  const { parts } = req.body ?? {};
  if (!Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: "parts is required" });
  }

  try {
    await s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: job.r2Key,
        UploadId: job.uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  } catch (err) {
    console.error(`[multipartRouter] complete failed for job ${jobId}:`, err);
    updateJob(jobId, {
      status: "error",
      error: "Couldn't finish the upload",
    });
    return res.status(502).json({ error: "Couldn't finish the upload" });
  }

  // The upload itself was never gated — only the processing step queues
  // (see queue.js) once every worker slot is busy, so this job sits
  // briefly rather than piling an unbounded ffmpeg process onto the box.
  updateJob(jobId, { status: "queued" });

  // Deliberately not awaited — the browser polls GET /jobs/:id instead of
  // blocking this response on however long queueing + trimming + pushing
  // back to R2 takes.
  enqueue(() =>
    processJob({
      jobId,
      r2Key: job.r2Key,
      startS: job.startS,
      endS: job.endS,
      isMp4: job.isMp4,
    }).catch((err) =>
      console.error(`[multipartRouter] processJob(${jobId}) crashed:`, err),
    ),
  );

  res.json({ ok: true });
}
