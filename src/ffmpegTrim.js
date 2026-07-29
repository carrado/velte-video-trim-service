import { spawn } from "child_process";

// A stream-copy trim of even a large file is normally single-digit seconds
// (see queue.js's comment) — this is a stall guard, not a "this file is
// just big" allowance. If ffmpeg goes this long without emitting a single
// -progress line (or any stderr output — see resetStall below), something's
// actually wrong (a broken container index that makes accurate -ss seeking
// degenerate into an unbounded scan, a genuinely dead HTTP connection to
// R2, etc.) and it's better to kill it and surface a real error than sit at
// a frozen progress percentage forever — which is exactly what happened
// before this existed: a stalled job just showed "processing 10%"
// indefinitely with no way to tell hung apart from working. Set higher than
// a pure-local trim would need, now that the input read itself goes over
// the network (see inputUrl below) — a slow-but-alive connection making an
// HTTP range request shouldn't get killed as if it were stuck.
const STALL_TIMEOUT_MS = 60_000;

// `inputUrl` is a presigned R2 GetObject URL, not a local path — ffmpeg's
// own HTTP protocol handler reads it directly, issuing byte-range requests
// as it seeks (R2, like S3, supports Range) rather than this service
// downloading the whole original to disk first. For a long original
// trimmed down to a short window, that's the difference between
// transferring the full file a second time (once for the vendor's upload,
// again for this service to read it) and transferring roughly just the
// container index plus the window actually being kept. Stream-copy only,
// no re-encode: fast and lossless, same keyframe-snap caveat as the old
// wasm approach this replaced (see velte's src/lib/videoTrim.ts).
export function trimFile({ inputUrl, outputPath, startS, endS, isMp4, onProgress }) {
  return new Promise((resolve, reject) => {
    const totalS = Math.max(endS - startS, 0.001);
    const args = [
      "-y",
      "-ss",
      String(startS),
      "-to",
      String(endS),
      "-i",
      inputUrl,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      ...(isMp4 ? ["-movflags", "+faststart"] : []),
      // Machine-readable progress on stdout (key=value lines, one block per
      // update) — separate from the human-readable stderr banner/stats we
      // still capture below for error messages.
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";
    let stdoutBuf = "";
    let settled = false;

    const stallTimer = setTimeout(() => {
      if (settled) return;
      ffmpeg.kill("SIGKILL");
      settle(() =>
        reject(
          new Error(
            `ffmpeg produced no progress for ${STALL_TIMEOUT_MS / 1000}s — killed as stalled`,
          ),
        ),
      );
    }, STALL_TIMEOUT_MS);
    stallTimer.unref();

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      fn();
    }

    function resetStall() {
      stallTimer.refresh();
    }

    ffmpeg.stdout.on("data", (chunk) => {
      resetStall();
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)/.exec(line);
        if (match) {
          const doneS = Number(match[1]) / 1e6;
          onProgress?.(Math.max(0, Math.min(1, doneS / totalS)));
        }
      }
    });
    ffmpeg.stderr.on("data", (chunk) => {
      resetStall();
      stderr += chunk.toString();
    });
    ffmpeg.on("error", (err) => settle(() => reject(err)));
    ffmpeg.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          onProgress?.(1);
          resolve();
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
        }
      });
    });
  });
}

// Grabs one frame from the already-trimmed LOCAL clip as this listing's
// poster image — Bunny auto-generates a thumbnail for videos uploaded
// directly to it, but R2 has no equivalent, so processJob.js mints one
// itself right after trimFile produces `inputPath`, before that file gets
// cleaned up. Runs against the local file, not another R2 read: the trimmed
// clip is already sitting on disk and is small (bounded by the 90s cap), so
// this is near-instant — no stall guard needed the way trimFile has one.
export function extractPosterFrame({ inputPath, outputPath, atS }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(atS),
      "-i",
      inputPath,
      "-vframes",
      "1",
      "-q:v",
      "3",
      outputPath,
    ];
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg poster extraction exited ${code}: ${stderr.slice(-500)}`),
        );
    });
  });
}
