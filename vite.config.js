import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    base: './',
    // The plugin's recommended config forces every asset inline. Manage the
    // shared settings here so only the web build can emit an external MP3.
    plugins: [viteSingleFile({ useRecommendedBuildConfig: false })],
    server: { host: '127.0.0.1', port: 5173 },
    build: {
      target: 'es2020',
      outDir: web ? 'dist-web' : 'dist',
      // JS is embedded in index.html. Keeping its referenced assets in the
      // same directory preserves relative import.meta.url paths after inlining.
      assetsDir: '',
      cssCodeSplit: false,
      assetsInlineLimit: file => !web || !/\.mp3$/i.test(file),
      rollupOptions: { output: { inlineDynamicImports: true } },
      chunkSizeWarningLimit: 6500
    }
  };
});
