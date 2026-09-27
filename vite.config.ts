import { realpathSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// Pin the Vite root to the config file's real on-disk path so flue() and
// Vite always agree, even when the launching shell reports the working
// directory with different casing (common with OneDrive paths).
export default defineConfig({
	// `.native` (not realpathSync): on OneDrive reparse points the JS
	// realpath returns the input casing unchanged, while `.native` returns
	// the real on-disk casing via the Windows API.
	root: realpathSync.native(import.meta.dirname),
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
