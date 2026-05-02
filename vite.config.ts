import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist-web',
  },
  define: {
    'process.env': {},
  },
});
