import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  } catch (err) {
    // The driver's error dumps the whole cluster topology; print what actually helps.
    console.error(`[mongo] could not connect: ${err.message}`);
    const serverErrors = [...(err.reason?.servers?.values() ?? [])].map((s) => s.error?.message).join(' ');
    if (/SSL alert number 80|tlsv1 alert internal error|timed out/i.test(`${err.message} ${serverErrors}`)) {
      console.error(
        '[mongo] Atlas refused the connection. Add this server\'s outbound IP (or 0.0.0.0/0) under ' +
          'Atlas → Security → Database & Network Access → IP Access List, then restart.'
      );
    }
    process.exit(1);
  }
  console.log('[mongo] connected');
  return mongoose.connection;
}
