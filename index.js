import { config, connectMongo, initPush } from '#shared';
import { createApp } from './src/app.js';

await connectMongo();
initPush();

createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});
