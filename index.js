import { config, connectMongo, initPush } from '#shared';
import { createApp } from './src/app.js';
import { startGroupCallSweeper } from './src/routes/groupCalls.js';

await connectMongo();
initPush();
startGroupCallSweeper();

createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});
