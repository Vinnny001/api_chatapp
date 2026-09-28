import { config, connectMongo } from '#shared';
import { createApp } from './src/app.js';

await connectMongo();

createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});
