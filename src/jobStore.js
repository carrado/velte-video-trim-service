// In-memory only — one VM, no horizontal scaling planned for this service,
// and a job's lifetime is minutes (upload → trim → push back to R2), so
// there's nothing worth persisting past a restart. Swept periodically so a
// vendor who abandons the flow mid-upload doesn't leak memory forever.
const jobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000; // 30 min past completion/error

// `extra` carries the bits multipartRouter.js's /uploads/init learns before
// the browser has uploaded anything (r2Key, uploadId, startS/endS, isMp4) —
// stashed on the job so /uploads/complete and processJob.js can look them
// back up by jobId instead of trusting the client to resend them later.
// jobStatusHandler only ever echoes status/progress/videoUrl/error back to
// the browser, so these extra fields stay server-side.
export function createJob(jobId, extra = {}) {
  jobs.set(jobId, {
    // "uploading" while the browser is still PUTting parts, then "queued"
    // the instant /uploads/complete finishes if every worker slot is busy
    // (see queue.js) — briefly, since trim jobs are fast. The client
    // doesn't treat "queued" specially, it's folded into the same
    // "processing" phase as "trimming"/"pushing", so this stays invisible
    // in the UI.
    status: "uploading",
    progress: 0,
    videoUrl: null,
    error: null,
    // Set by cancelRouter.js when the vendor cancels mid-trim/push (too
    // late to abort the R2 multipart upload or already past it) —
    // processJob.js checks this right before marking the job "done" and
    // deletes what it just pushed instead of keeping it.
    cancelled: false,
    updatedAt: Date.now(),
    ...extra,
  });
}

export function updateJob(jobId, patch) {
  const existing = jobs.get(jobId);
  if (!existing) return;
  jobs.set(jobId, { ...existing, ...patch, updatedAt: Date.now() });
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();
