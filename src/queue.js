import { env } from "./env.js";

// Bounds how many trim+push-back-to-R2 pipelines run at once — NOT the
// uploads. Every vendor's upload starts immediately and parts go straight
// to R2 regardless of this limit (see multipartRouter.js's initUpload);
// only the brief post-upload processing step queues here, so a burst of
// concurrent finishes doesn't spawn an unbounded pile of ffmpeg processes
// and OOM/disk-exhaust the instance.
//
// Because trimVideo (see ffmpegTrim.js) is a stream-copy, not a re-encode,
// each job's real work is typically single-digit seconds even for a large
// file — so a burst clears in short rounds regardless of the exact pool
// size: a 23-job burst against MAX_CONCURRENT_JOBS=8 is ~3 rounds, not a
// long wait. 8 is a number to test, not a measured ceiling — run
// `npm run load-test` (scripts/load-test.js) against a real deploy and
// adjust based on what actually happens, not this comment.
let running = 0;
const pending = [];

function drain() {
  while (running < env.maxConcurrentJobs && pending.length > 0) {
    const task = pending.shift();
    running++;
    task()
      .catch(() => {}) // task itself is responsible for its own error handling/logging
      .finally(() => {
        running--;
        drain();
      });
  }
}

export function enqueue(task) {
  pending.push(task);
  drain();
}
