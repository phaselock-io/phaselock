import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// the database, whose routes under /phaselock the dev server proxies so the UI reaches it from
// its own origin
const DB = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: { '/phaselock': DB },
  },
});
