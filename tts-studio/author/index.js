// Run the lesson writer on its own: `npm run author`.
// `npm start` already runs one inside the dashboard's process, so this is only for
// running it elsewhere; point the dashboard at it with TTS_AUTHOR_URL.
import { loadConfig } from '../server/config.js';
import { createAuthorApp } from './app.js';

const cfg = loadConfig();
const app = createAuthorApp({ getConfig: loadConfig });
const server = app.listen(cfg.authorPort, cfg.host, () => {
  console.log(`\n  Lesson writer    http://localhost:${cfg.authorPort}`);
  console.log(`  Projects         ${cfg.videoDir}/projects`);
  console.log(`  Claude           ${cfg.claudeBin}${cfg.claudeModel ? ` (${cfg.claudeModel})` : ''}\n`);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.authorPort} is already in use. Set AUTHOR_PORT=... in your .env.` : e);
  process.exit(1);
});
const shutdown = () => {
  app.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => app.stop());
