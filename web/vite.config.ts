import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// React SPA build, separate from the Flue worker build (root vite.config.ts).
// Emits static assets into ../public, which wrangler serves as Workers assets.
export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	build: {
		outDir: '../public',
		emptyOutDir: true,
	},
});
