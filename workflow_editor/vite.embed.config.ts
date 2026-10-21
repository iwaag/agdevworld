import { defineConfig } from 'vite'

// The embeddable graph (argue p4 ex3, src/embed/graph.ts): one ES module at
// dist/embed/graph.js, served by the editor's service as /wfe/embed/graph.js
// for other pages of the agdev origin. The main build empties dist/ first;
// this one adds to it.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/embed',
    emptyOutDir: true,
    lib: { entry: 'src/embed/graph.ts', formats: ['es'], fileName: () => 'graph.js' },
  },
})
