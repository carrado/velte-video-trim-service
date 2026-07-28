import { jwtVerify } from "jose";
import { env } from "./env.js";

const secret = new TextEncoder().encode(env.jwtSecret);

// Verifies the short-lived token minted by the Velte app's
// POST /api/videos/trim-auth. Every request touching an upload (create,
// chunk append, and the tus session's own metadata) must carry a valid one
// via `Authorization: Bearer <token>` — there's no user session cookie to
// check here, this token IS the auth.
export async function verifyUploadToken(authHeader) {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new Error("Missing bearer token");
  const { payload } = await jwtVerify(token, secret);
  if (!payload.sub || !payload.jobId) throw new Error("Malformed token");
  return { userId: String(payload.sub), jobId: String(payload.jobId) };
}
