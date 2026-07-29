import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { SignJWT } from "jose";

// Fires N concurrent "vendor trims" at a real (local or deployed) instance
// of this service, to find MAX_CONCURRENT_JOBS's actual ceiling instead of
// guessing. Signs tokens locally with TRIM_SERVICE_JWT_SECRET rather than
// going through Velte's /api/videos/trim-auth — that route is a trivial
// Next.js handler, not what we're trying to stress-test here; this exercises
// exactly the component in question (multipartRouter.js + queue.js +
// ffmpeg + bunnyPush.js) the same way the real flow would: parallel
// presigned-part PUTs straight to R2, then /uploads/complete, then polling
// GET /jobs/:id the same way videoTrim.ts does.
//
// Usage:
//   npm run load-test -- --file ./sample-large.mp4 --concurrency 23 --url http://localhost:8787
//
// Needs a real, valid video file — ffmpeg has to actually be able to
// stream-copy it, so random bytes won't do. Generate one with:
//   ffmpeg -f lavfi -i "testsrc=size=1920x1080:rate=30" -t 180 -c:v libx264 -b:v 12M sample-large.mp4
// (roughly a 3-minute, ~270MB synthetic clip at that bitrate — raise -b:v
// or -t to push it closer to the real 300-500MB range vendors actually hit)

function parseArgs() {
  const args = { concurrency: 23, url: null, file: null, endS: 30 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "concurrency" || key === "endS") args[key] = Number(argv[++i]);
    else if (key === "url" || key === "file") args[key] = argv[++i];
  }
  return args;
}

function secret() {
  const s = process.env.TRIM_SERVICE_JWT_SECRET;
  if (!s) throw new Error("TRIM_SERVICE_JWT_SECRET is not set in .env");
  return new TextEncoder().encode(s);
}

async function signToken(jobId) {
  return new SignJWT({ jobId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`load-test-${jobId}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret());
}

// Reads one part's bytes synchronously off disk — fine for a load-testing
// script (not the real client, see videoTrim.ts for the browser's actual
// File.slice()-based version), simplest thing that produces the right
// bytes per part without pulling in a stream-slicing dependency here.
function readPart(fd, start, length) {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, start);
  return read === length ? buf : buf.subarray(0, read);
}

async function runOneJob({ index, baseUrl, filePath, endS }) {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const fileSize = statSync(filePath).size;

  try {
    const token = await signToken(jobId);
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const initRes = await fetch(`${baseUrl}/uploads/init`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        contentType: "video/mp4",
        fileSize,
        startS: 0,
        endS,
      }),
    });
    if (!initRes.ok) {
      return { index, jobId, ok: false, stage: "init", error: `HTTP ${initRes.status}` };
    }
    const { partSize, parts } = await initRes.json();

    const fd = openSync(filePath, "r");
    const uploadedParts = await Promise.all(
      parts.map(async ({ partNumber, url }) => {
        const start = (partNumber - 1) * partSize;
        const length = Math.min(partSize, fileSize - start);
        const body = readPart(fd, start, length);
        const res = await fetch(url, { method: "PUT", body });
        if (!res.ok) throw new Error(`part ${partNumber} failed: HTTP ${res.status}`);
        const etag = res.headers.get("ETag");
        if (!etag) throw new Error(`part ${partNumber} response missing ETag (check R2 CORS ExposeHeaders)`);
        return { partNumber, etag };
      }),
    );
    closeSync(fd);
    const uploadMs = Date.now() - startedAt;

    const completeRes = await fetch(`${baseUrl}/uploads/complete`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ parts: uploadedParts }),
    });
    if (!completeRes.ok) {
      return { index, jobId, ok: false, stage: "complete", error: `HTTP ${completeRes.status}` };
    }

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await fetch(`${baseUrl}/jobs/${jobId}`).catch(() => null);
      if (res?.ok) {
        const job = await res.json();
        if (job.status === "done") {
          return {
            index,
            jobId,
            ok: true,
            timings: { uploadMs, totalMs: Date.now() - startedAt },
            videoUrl: job.videoUrl,
          };
        }
        if (job.status === "error") {
          return { index, jobId, ok: false, stage: "process", error: job.error };
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { index, jobId, ok: false, stage: "process", error: "timed out polling" };
  } catch (err) {
    return { index, jobId, ok: false, stage: "upload", error: String(err) };
  }
}

async function main() {
  const { concurrency, url, file, endS } = parseArgs();

  if (!file || !existsSync(file)) {
    console.error(
      "Missing or not-found --file. Generate a real sample video first, e.g.:\n" +
        '  ffmpeg -f lavfi -i "testsrc=size=1920x1080:rate=30" -t 180 -c:v libx264 -b:v 12M sample-large.mp4\n' +
        "then: npm run load-test -- --file ./sample-large.mp4",
    );
    process.exit(1);
  }

  const baseUrl = (url ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
  const sizeMB = (statSync(file).size / (1024 * 1024)).toFixed(1);

  console.log(
    `Firing ${concurrency} concurrent jobs at ${baseUrl} using ${file} (${sizeMB}MB), trimming to ${endS}s...`,
  );
  console.log("Watch the instance's memory/CPU in Render's dashboard (or `top` locally) while this runs.\n");

  const batchStart = Date.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      runOneJob({ index, baseUrl, filePath: file, endS }),
    ),
  );
  const batchMs = Date.now() - batchStart;

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totals = ok.map((r) => r.timings.totalMs).sort((a, b) => a - b);

  console.log(`\nDone in ${(batchMs / 1000).toFixed(1)}s total.`);
  console.log(`Succeeded: ${ok.length}/${concurrency}   Failed: ${failed.length}/${concurrency}`);
  if (totals.length) {
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    console.log(
      `Per-job time (upload start → trimmed clip live on R2): min ${(totals[0] / 1000).toFixed(1)}s, ` +
        `avg ${(avg / 1000).toFixed(1)}s, max ${(totals[totals.length - 1] / 1000).toFixed(1)}s`,
    );
  }
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  job ${f.index} (${f.jobId}) — ${f.stage}: ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
