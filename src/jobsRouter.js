import { getJob } from "./jobStore.js";

// GET /jobs/:id — polled by the browser (see videoTrim.ts) while a job
// works through uploading -> queued -> trimming -> pushing -> done/error.
// Only ever echoes the public-facing fields back; r2Key/uploadId/startS/
// endS/isMp4 stashed on the job by multipartRouter.js stay server-side.
export function jobStatusHandler(req, res) {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl,
    error: job.error,
  });
}
