import devServer from "@hono/vite-dev-server";
import nodeAdapter from "@hono/vite-dev-server/node";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 3001);

export default defineConfig(({ command }) => ({
  appType: "custom",
  plugins:
    command === "serve"
      ? [
          devServer({
            entry: "server/app.ts",
            adapter: nodeAdapter(),
          }),
        ]
      : [],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
  },
  build: {
    minify: false,
    outDir: "dist/server",
    emptyOutDir: true,
    sourcemap: true,
    ssr: "server/index.ts",
    target: "node25",
    rollupOptions: {
      output: {
        entryFileNames: "index.mjs",
        format: "es",
      },
    },
  },
}));
