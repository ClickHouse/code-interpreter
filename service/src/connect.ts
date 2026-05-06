import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI ?? '';

interface MongooseConnection {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

interface GlobalWithMongoose extends Global {
  mongoose?: MongooseConnection;
}

// Define a type for mongoose connection with _readyState
interface MongooseConnectionWithState {
  _readyState: number;
}

declare const global: GlobalWithMongoose;

/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
const cached: MongooseConnection = (global.mongoose || {
  conn: null,
  promise: null,
}) as MongooseConnection;

if (!global.mongoose) {
  global.mongoose = cached;
}

export async function connectDb(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    return cached.conn as typeof mongoose;
  }
  const conn = cached.conn as unknown as MongooseConnectionWithState | null;

  if (conn?._readyState === 1) {
    return cached.conn as typeof mongoose;
  }

  const disconnected = conn?._readyState !== 1;
  if (!cached.promise || disconnected === true) {
    const opts = {
      bufferCommands: false,
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
      // bufferMaxEntries: 0,
      // useFindAndModify: true,
      // useCreateIndex: true
    };

    mongoose.set('strictQuery', true);
    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}