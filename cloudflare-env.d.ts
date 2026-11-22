declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    // Realtime multiplayer: one PitthuRoom Durable Object per room code.
    // Bound in vite.config.ts (durable_objects, migrations tag v1).
    PITTHU_ROOM: DurableObjectNamespace;
  }
}
