// Runs the library in your browser: `npm start`, then open the printed address.
// (The desktop app starts the same server from electron/main.js.)
import { PORT, HOST, LIBRARY_DIR, settings, aiEnabled } from './src/config.js';
import { startServer } from './src/server.js';
import { flush } from './src/store.js';

const { url } = await startServer({ port: PORT, host: HOST });
console.log(`\n  Magpie  →  ${url}`);
console.log(`  Files live in     ${LIBRARY_DIR}`);
console.log(aiEnabled() ? `  Auto-sorting with ${settings.model}\n` : '  Auto-sorting is off: you choose folders (add an API key in Settings to turn it on)\n');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
