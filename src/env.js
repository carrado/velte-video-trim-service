import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appOrigin: required("APP_ORIGIN").replace(/\/$/, ""),
  jwtSecret: required("TRIM_SERVICE_JWT_SECRET"),
  internalSecret: required("TRIM_SERVICE_INTERNAL_SECRET"),
  // Local scratch space ONLY — uploads no longer land here (see r2Client.js
  // and uploadsRouter.js, which stream straight to R2 instead), this is just
  // where a worker briefly downloads ITS ONE file to run ffmpeg on, bounded
  // by MAX_CONCURRENT_JOBS rather than by how many vendors are uploading.
  uploadDir: process.env.UPLOAD_DIR ?? "./tmp/uploads",
  // Cloudflare R2 — where uploads actually land (S3-compatible API, free
  // tier: 10GB storage, zero egress fees). Get these from the Cloudflare
  // dashboard → R2 → Manage API Tokens. See README's "Cloudflare R2 setup".
  r2AccountId: required("R2_ACCOUNT_ID"),
  r2AccessKeyId: required("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  r2Bucket: required("R2_BUCKET_NAME"),
  // How many trim+push-to-Bunny jobs run at once — see queue.js. Bumped
  // from the original conservative 3 to test whether free tier's 0.1
  // shared vCPU holds up at a higher number — stream-copy is mostly disk
  // I/O, not sustained CPU, so 3 may have been overly cautious. Run
  // `npm run load-test` (see scripts/load-test.js) to find the real
  // ceiling before trusting this number under a real vendor burst.
  // Uploads themselves are never limited by this number.
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS ?? 8),
};
