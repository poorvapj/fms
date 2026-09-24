import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Development and preview both forward /api to the separate backend (override with VITE_API_PROXY).
  server: { port: 5600, strictPort: true, proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4600' } },
  preview: { port: 5600, strictPort: true, proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4600' } },
});
