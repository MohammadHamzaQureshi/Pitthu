import handler from "vinext/server/fetch-handler";

// Re-exported so Wrangler can find the Durable Object class. The class
// itself lives in ./room-do.ts; the binding is declared in vite.config.ts
// (durable_objects: PITTHU_ROOM -> PitthuRoom, migrations tag v1).
export { PitthuRoom } from "./room-do";

// v3: pin the Durable Object near the player who first touches the room.
// Cloudflare only honors { locationHint } on the FIRST get() that
// instantiates the object for a room code — later get() calls ignore it.
// The creator's WebSocket upgrade is usually that first touch (the
// lobby API's roomStub is the other one — see app/api/room/route.ts),
// so the hint is passed at BOTH places, derived from the request's
// Cloudflare metadata (request.cf.continent). 'AS' -> 'apac' is the one
// that matters for this game's players (India); the rest are mapped for
// completeness. Undefined = let Cloudflare choose.
function locationHintForCf(cf: any): string | undefined {
  const c = typeof cf?.continent === "string" ? cf.continent : "";
  if (c === "AS") return "apac";
  if (c === "NA") return "enam";
  if (c === "SA") return "sam";
  if (c === "EU") return "weur";
  if (c === "AF") return "afr";
  if (c === "OC") return "oc";
  return undefined;
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Realtime multiplayer: WebSocket upgrades go to the room's Durable
    // Object (one object per room code). Both paths are accepted so old
    // links/bookmarks keep working:
    //   wss://<host>/ws?code=XXXXXX&token=<uuid>
    //   wss://<host>/api/room/ws?code=XXXXXX&token=<uuid>
    if (url.pathname === "/ws" || url.pathname === "/api/room/ws") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) {
        return Response.json({ error: "Enter a six-character room code." }, { status: 400 });
      }
      if (!env.PITTHU_ROOM) {
        return Response.json(
          {
            error:
              "Realtime rooms are not deployed yet. The PitthuRoom Durable Object binding (PITTHU_ROOM) is missing — deploy with `wrangler deploy` (see README). Polling fallback was removed because it caused lag.",
          },
          { status: 503 },
        );
      }
      const id = env.PITTHU_ROOM.idFromName(code);
      const hint = locationHintForCf((request as any).cf);
      const stub = hint ? env.PITTHU_ROOM.get(id, { locationHint: hint }) : env.PITTHU_ROOM.get(id);
      // Forward the upgrade request verbatim (Upgrade headers included);
      // the Durable Object answers 101 and owns the socket from there.
      return stub.fetch(
        new Request(`http://pitthu-room/ws?code=${code}&token=${encodeURIComponent(url.searchParams.get("token") || "")}`, request),
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
