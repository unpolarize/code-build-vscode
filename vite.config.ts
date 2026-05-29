import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds the React webview into dist/webview/{webview.js,webview.css} with fixed
// names so the extension host can reference them via asWebviewUri.
export default defineConfig({
  root: 'webview-ui',
  plugins: [react()],
  base: '',
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]',
        chunkFileNames: 'webview-[name].js'
      }
    }
  }
});
