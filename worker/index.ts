import handler from "vinext/server/fetch-handler";

// Re-exported so Wrangler can find the Durable Object class. The class
// itself lives in ./room-do.ts; the binding is declared in vite.config.ts
// (durable_objects: PITTHU_ROOM -> PitthuRoom, migrations tag v1).
export { PitthuRoom } from "./room-do";

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
      const stub = env.PITTHU_ROOM.get(id);
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
