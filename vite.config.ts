import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'ort': ['onnxruntime-web'],
          'vad': ['@ricky0123/vad-web'],
          'doc-preview': ['docx-preview', 'pptx-preview'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
