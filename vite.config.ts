import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_BASE, SCORE_ORIGIN } from './shared/musescore-contract.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'ios-viewport-fit',
      transformIndexHtml(html) {
        if (process.env.VITE_IOS_SHELL !== '1') return html;
        return html.replace(
          'width=device-width, initial-scale=1.0',
          'width=device-width, initial-scale=1.0, viewport-fit=cover',
        );
      },
    },
  ],
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
