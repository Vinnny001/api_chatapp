import { config, connectMongo, initPush } from '#shared';
import { createApp } from './src/app.js';
import { startGroupCallSweeper } from './src/routes/groupCalls.js';
import { startScheduler } from './src/routes/conversations.js';
import { migrateMlsRetention } from './src/models/Mls.js';

await connectMongo();
migrateMlsRetention(); // (in the background)
initPush();
startGroupCallSweeper();
startScheduler(); // scheduled messages

createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});
