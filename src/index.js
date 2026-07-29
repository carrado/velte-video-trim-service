import { mkdirSync } from "fs";
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { initUpload, completeUpload } from "./multipartRouter.js";
import { jobStatusHandler } from "./jobsRouter.js";
import { cancelUpload } from "./cancelRouter.js";

mkdirSync(env.uploadDir, { recursive: true });

const app = express();

// Only the Velte app's own origin may call THIS service's routes — video
// bytes themselves no longer pass through here at all (they go browser -> R2
// directly against presigned URLs, see multipartRouter.js), so this only
// ever needs to gate small JSON requests: minting an upload job, completing
// it, and status polls.
app.use(
  cors({
    origin: env.appOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/uploads/init", initUpload);
app.post("/uploads/complete", completeUpload);
app.post("/uploads/cancel", cancelUpload);
app.get("/jobs/:id", jobStatusHandler);

app.listen(env.port, () => {
  console.log(`[velte-video-trim-service] listening on :${env.port}`);
});
