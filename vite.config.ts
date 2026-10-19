// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'chrome108',
    outDir: 'dist',
    emptyOutDir: true
  }
});
