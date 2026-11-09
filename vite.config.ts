import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// foliate-js lazily imports its own pdf.js adapter (with a vendor glob Vite can't resolve).
// PDFs are rendered by our pdf.js engine instead, so stub that module out.
const stubFoliatePdf = (): Plugin => ({
  name: "stub-foliate-pdf",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./pdf.js" && importer?.includes("foliate-js")) return "\0foliate-pdf-stub";
  },
  load(id) {
    if (id === "\0foliate-pdf-stub") return "export const makePDF = () => { throw new Error('PDF is handled by the pdf.js engine'); };";
  },
});

export default defineConfig(async () => ({
  plugins: [stubFoliatePdf(), tailwindcss(), react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  optimizeDeps: { exclude: ["foliate-js"] },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: { environment: "node" },
}));
