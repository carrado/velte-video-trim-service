import { spawn } from "child_process";

// Mirrors the args the client used to run through wasm ffmpeg (see
// velte's src/lib/videoTrim.ts trimVideo() — kept there for reference even
// though it's no longer called). Stream-copy only, no re-encode: fast and
// lossless, same keyframe-snap caveat as before. The only thing that
// changed is WHERE this runs — a real native ffmpeg binary here has none of
// wasm's memory ceiling or codec-support gaps.
export function trimFile({ inputPath, outputPath, startS, endS, isMp4 }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(startS),
      "-to",
      String(endS),
      "-i",
      inputPath,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      ...(isMp4 ? ["-movflags", "+faststart"] : []),
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
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
