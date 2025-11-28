// frontend/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // ✅ consenti tutti i sottodomini di ngrok
    allowedHosts: [".ngrok-free.app"],
    // oppure, se vuoi essere super letterale:
    // allowedHosts: ["4aa5113a822a.ngrok-free.app"],
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true
      }
    }
  },
  build: {
    sourcemap: true
  },
  resolve: {
    alias: {
      "@": "/src"
    }
  }
});
