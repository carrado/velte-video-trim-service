// In-memory only — one VM, no horizontal scaling planned for this service,
// and a job's lifetime is minutes (upload → trim → push to Bunny), so
// there's nothing worth persisting past a restart. Swept periodically so a
// vendor who abandons the flow mid-upload doesn't leak memory forever.
const jobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000; // 30 min past completion/error

export function createJob(jobId) {
  jobs.set(jobId, {
    // "uploading" while tus is still receiving chunks, then "queued" the
    // instant it finishes if every worker slot is busy (see queue.js) —
    // briefly, since trim jobs are fast. The client doesn't treat "queued"
    // specially, it's folded into the same "processing" phase as
    // "trimming"/"pushing", so this stays invisible in the UI.
    status: "uploading",
    progress: 0,
    bunnyUrl: null,
    error: null,
    updatedAt: Date.now(),
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
