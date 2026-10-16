import { config, connectMongo, initPush } from '#shared';
import { createApp } from './src/app.js';
import { startGroupCallSweeper } from './src/routes/groupCalls.js';
import { migrateMlsRetention } from './src/models/Mls.js';

await connectMongo();
migrateMlsRetention(); // (in the background)
initPush();
startGroupCallSweeper();

createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});
