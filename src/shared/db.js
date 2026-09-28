import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  console.log('[mongo] connected');
  return mongoose.connection;
}
