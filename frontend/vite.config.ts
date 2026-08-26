import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { fileRoutes } from "filesystem-routing/vite";

export default defineConfig({
  // `extensions` lets the Solid plugin also compile the `?pick=` route
  // modules that fileRoutes() emits for file-based routing.
  plugins: [solid({ extensions: [".jsx", ".tsx"] }), fileRoutes()],
  server: { port: 5174 }, // 5173 is the test-client
});
