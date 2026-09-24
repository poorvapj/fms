import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Two environments, each talking to its own backend (and so its own database):
//   local (default): UI 5600 → API 4600      live (`--mode live`): UI 5700 → API 4700
// VITE_API_PROXY overrides the backend address.
export default defineConfig(({ mode }) => {
  const live = mode === 'live';
  const port = live ? 5700 : 5600;
  const proxy = { '/api': process.env.VITE_API_PROXY ?? `http://localhost:${live ? 4700 : 4600}` };
  return {
    plugins: [react()],
    build: { outDir: live ? 'dist-live' : 'dist' },
    server: { port, strictPort: true, proxy },
    preview: { port, strictPort: true, proxy },
  };
});
