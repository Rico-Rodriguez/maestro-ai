import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_BASE, SCORE_ORIGIN } from './shared/musescore-contract.mjs';

export default defineConfig({
  plugins: [react()],
  base: APP_BASE,
  server: {
    proxy: {
      [`${APP_BASE}api`]: {
        target: SCORE_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
