import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({ base: './', plugins: [viteSingleFile()], server: { host: '127.0.0.1', port: 5173 }, build: { target: 'es2020', cssCodeSplit: false, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 900 } });
