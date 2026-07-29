import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

// R2 speaks the S3 API, so the standard AWS SDK works against it unchanged
// once pointed at R2's endpoint — no Cloudflare-specific SDK needed.
//
// r2ClientConfig is exported alongside the built client mostly for
// completeness — every current consumer (multipartRouter.js's
// CreateMultipartUpload/UploadPart/CompleteMultipartUpload,
// processJob.js's GetObject/DeleteObject, both via @aws-sdk/s3-request-
// presigner for presigned URLs) just calls `.send()`/`getSignedUrl()` on
// the built `s3Client` below.
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
