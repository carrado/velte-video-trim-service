import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

// R2 speaks the S3 API, so the standard AWS SDK works against it unchanged
// once pointed at R2's endpoint — no Cloudflare-specific SDK needed.
//
// Exported as both a raw config AND a built client, because the two
// consumers need different shapes: @tus/s3-store's S3Store (used in
// uploadsRouter.js) builds its OWN internal S3 client from a config object
// — it does NOT accept a pre-built client instance (confirmed against the
// installed package's source, not just its types) — while processJob.js's
// direct GetObject/DeleteObject calls need an actual client to call
// `.send()` on.
export const r2ClientConfig = {
  region: "auto",
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
  },
};

export const s3Client = new S3Client(r2ClientConfig);

export const R2_BUCKET = env.r2Bucket;
