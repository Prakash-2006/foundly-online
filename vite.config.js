import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fromRoot('./index.html'),
        admin: fromRoot('./admin.html'),
      },
    },
  },
});
