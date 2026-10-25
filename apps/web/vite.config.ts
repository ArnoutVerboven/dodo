import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes('node_modules/@firebase') || id.includes('node_modules/firebase')
            ? 'firebase'
            : id.includes('react-markdown') ||
                id.includes('remark') ||
                id.includes('micromark') ||
                id.includes('mdast')
              ? 'markdown'
              : undefined,
      },
    },
  },
});
