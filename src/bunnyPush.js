import { createReadStream, statSync } from "fs";
import { Upload } from "tus-js-client";
import { env } from "./env.js";

const BUNNY_TUS_ENDPOINT = "https://video.bunnycdn.com/tusupload";

// Mirrors src/lib/bunnyStream.ts's uploadVideoToBunny() on the frontend,
// just running server-side against a file on disk instead of a browser
// File object. Deliberately never holds the real Bunny API key here — it
// asks the Velte app's bunny-upload-auth-internal route (shared-secret
// gated) for a single-video, time-boxed signature, same pattern the
// browser's own upload flow uses.
export async function pushToBunny({ filePath, title, onProgress }) {
  const authRes = await fetch(
    `${env.appOrigin}/api/videos/bunny-upload-auth-internal`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.internalSecret,
      },
      body: JSON.stringify({ title }),
    },
  );
  if (!authRes.ok) {
    throw new Error(`bunny-upload-auth-internal failed (${authRes.status})`);
  }
  const { videoId, libraryId, signature, expire } = await authRes.json();

  const fileSize = statSync(filePath).size;

  await new Promise((resolve, reject) => {
    const upload = new Upload(createReadStream(filePath), {
      endpoint: BUNNY_TUS_ENDPOINT,
      uploadSize: fileSize,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expire),
        VideoId: videoId,
        LibraryId: libraryId,
      },
      metadata: { filetype: "video/mp4", title },
      onError: reject,
      onProgress: (sent, total) => onProgress?.(total > 0 ? sent / total : 0),
      onSuccess: () => resolve(),
    });
    upload.start();
  });

  return `https://player.mediadelivery.net/embed/${libraryId}/${videoId}`;
}
