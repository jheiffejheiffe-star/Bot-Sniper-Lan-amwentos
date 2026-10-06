import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
    // O servidor roda atrás de proxy reverso (sandbox de preview / Cloud Run), portanto o
    // Host header não é "localhost". Sem isto, o Vite responde 403 "Blocked request" e a
    // interface não carrega.
    allowedHosts: true,
  },
});
