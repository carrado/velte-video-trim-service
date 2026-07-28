import { mkdirSync } from "fs";
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { createTusServer, jobStatusHandler } from "./uploadsRouter.js";

mkdirSync(env.uploadDir, { recursive: true });

const app = express();

// Only the Velte app's own origin may start an upload here — this service
// holds no user-facing auth of its own beyond the per-job bearer token,
// which is enough to stop random internet POSTs but CORS keeps it from
// being embeddable/callable from anywhere else in a browser context too.
app.use(
  cors({
    origin: env.appOrigin,
    methods: ["GET", "POST", "PATCH", "HEAD", "OPTIONS", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset"],
    exposedHeaders: ["Location", "Upload-Offset", "Tus-Resumable", "Tus-Version", "Tus-Max-Size"],
  }),
);

app.get("/health", (_req, res) => res.json({ ok: true }));

const tusServer = createTusServer();
app.all("/uploads", tusServer.handle.bind(tusServer));
app.all("/uploads/*", tusServer.handle.bind(tusServer));

app.get("/jobs/:id", jobStatusHandler);

app.listen(env.port, () => {
  console.log(`[velte-video-trim-service] listening on :${env.port}`);
});
