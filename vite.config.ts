import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_BASE } from './shared/musescore-contract.mjs';

export default defineConfig({
  plugins: [react()],
  base: APP_BASE,
});
