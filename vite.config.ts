import vinext from "vinext";
import { defineConfig } from "vite";

// ⚠️ MUST BE REPLACED BEFORE DEPLOY: this is a placeholder, not a real
// database. Create a real D1 database first:
//   npx wrangler d1 create pitthu-rooms-db
//   npx wrangler d1 migrations apply pitthu-rooms-db
// …then paste the returned database_id here. Until then, creating or
// joining a room fails with "Room service is warming up" / 503, because
// the lobby is stored in D1 (the Durable Object hydrates from it).
const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

const workerConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    {
      binding: "DB",
      database_name: "pitthu-rooms-db",
      database_id: D1_PLACEHOLDER_ID,
    },
  ],
  // Realtime multiplayer: one PitthuRoom Durable Object per room code.
  // The class is exported from worker/index.ts (defined in worker/room-do.ts).
  // migrations tag "v1" registers the new SQLite-backed Durable Object class;
  // bump the tag if the class name ever changes.
  durable_objects: {
    bindings: [{ name: "PITTHU_ROOM", class_name: "PitthuRoom" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PitthuRoom"] }],
};

export default defineConfig(async () => {
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: workerConfig,
      }),
    ],
  };
});
