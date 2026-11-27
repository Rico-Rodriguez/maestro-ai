import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_BASE, SCORE_ORIGIN } from './shared/musescore-contract.mjs';
import { iosIndexHtml } from './src/ios-viewport.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'ios-viewport-fit',
      transformIndexHtml(html) {
        if (process.env.VITE_IOS_SHELL !== '1') return html;
        return iosIndexHtml(html);
      },
    },
  ],
  build: {
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
  },
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
