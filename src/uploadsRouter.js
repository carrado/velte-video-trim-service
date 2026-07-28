import { Server as TusServer } from "@tus/server";
import { S3Store } from "@tus/s3-store";
import { verifyUploadToken } from "./auth.js";
import { createJob, updateJob, getJob } from "./jobStore.js";
import { processJob } from "./processJob.js";
import { enqueue } from "./queue.js";
import { r2ClientConfig, R2_BUCKET } from "./r2Client.js";

// NOTE: both @tus/server's and @tus/s3-store's APIs have shifted across
// major versions — verify onUploadCreate/onUploadFinish's exact hook
// signature and S3Store's constructor shape against whatever versions
// actually install (`npm ls @tus/server @tus/s3-store`) before deploying;
// this targets @tus/server v1.x's (req, res, upload) => res hook shape and
// @tus/s3-store v1.x's { s3ClientConfig, bucket } constructor shape.
export function createTusServer() {
  return new TusServer({
    path: "/uploads",
    // Uploads land in R2, not local disk — this is the fix for disk usage
    // scaling with concurrent vendors instead of with MAX_CONCURRENT_JOBS
    // (see env.js's uploadDir comment). Object key defaults to upload.id,
    // same as FileStore's local filename used to be — processJob.js reads
    // that back out via upload.id below.
    datastore: new S3Store({
      s3ClientConfig: { bucket: R2_BUCKET, ...r2ClientConfig },
    }),

    // Every request in a tus session (create, each chunk append) must carry
    // the same valid job token — there's no session cookie here, this token
    // IS the auth, and it's scoped to exactly one jobId so one vendor's
    // token can't be replayed against another job.
    onUploadCreate: async (req, res, upload) => {
      const { jobId } = await verifyUploadToken(req.headers.authorization);
      const metaJobId = upload.metadata?.jobId;
      if (metaJobId !== jobId) {
        throw { status_code: 403, body: "jobId does not match token" };
      }
      createJob(jobId);
      return res;
    },

    onUploadFinish: async (req, res, upload) => {
      const { jobId } = await verifyUploadToken(req.headers.authorization);
      const metadata = upload.metadata ?? {};
      const startS = Number(metadata.startS ?? 0);
      const endS = Number(metadata.endS ?? 0);
      const isMp4 = metadata.filetype !== "video/webm";
      // The R2 object key — processJob.js downloads this to local disk
      // itself once a worker slot picks it up, rather than the file
      // already sitting on local disk the way FileStore used to leave it.
      const r2Key = upload.id;

      // The upload itself was never gated — only the processing step queues
      // (see queue.js) once every worker slot is busy, so this job sits
      // briefly rather than piling an unbounded ffmpeg process onto the box.
      updateJob(jobId, { status: "queued" });

      // Deliberately not awaited — the browser polls GET /jobs/:id instead
      // of blocking the tus response (which must return promptly) on
      // however long queueing + trimming + the Bunny push takes.
      enqueue(() =>
        processJob({ jobId, r2Key, startS, endS, isMp4 }).catch((err) =>
          console.error(`[uploadsRouter] processJob(${jobId}) crashed:`, err),
        ),
      );

      return res;
    },
  });
}

export function jobStatusHandler(req, res) {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    bunnyUrl: job.bunnyUrl,
    error: job.error,
  });
}
