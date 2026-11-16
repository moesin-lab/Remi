/** Web-owned identity, never forwarded to the API. */
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ build_id: process.env.NEXT_PUBLIC_REMI_WEB_BUILD_ID }, {
    headers: { "Cache-Control": "no-store" },
  });
}
