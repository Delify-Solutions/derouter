import { openLocalImage, statLocalImage } from "@/lib/storage/localImages.js";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

function headersFor(image) {
  return {
    "Content-Type": image.type,
    "Content-Length": String(image.size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Access-Control-Allow-Origin": "*",
  };
}

/**
 * GET /api/public/images/<yyyymmdd>-<uuid>.<ext> — a generated image kept on the
 * router's disk (spec image-storage "Local image storage"). Public: the link is
 * what the customer receives, and the random name is its only protection. A file
 * never changes, so it may be cached for good.
 */
export async function GET(request, { params }) {
  const { name } = await params;
  const image = await openLocalImage(name);
  if (!image) return NOT_FOUND();
  return new Response(image.stream, { headers: headersFor(image) });
}

/**
 * Explicit, so Next does not answer HEAD by running GET: it would open a file
 * stream that a HEAD response never reads or closes (one leaked fd per request).
 */
export async function HEAD(request, { params }) {
  const { name } = await params;
  const image = await statLocalImage(name);
  if (!image) return NOT_FOUND();
  return new Response(null, { headers: headersFor(image) });
}
