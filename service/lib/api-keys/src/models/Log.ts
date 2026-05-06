import mongoose from 'mongoose';

export interface ILog {
  input?: string;
  run?: {
    signal?: string | number | null;
    stdout?: string;
    stderr?: string;
    code?: number;
    output?: string;
    memory?: number | null;
    message?: string;
    status?: string;
    cpu_time?: number;
    wall_time?: number;
  };
  language?: string;
  version?: string;
  session_id?: string;
  files?: Array<{
    id?: string;
    name?: string;
  }>;
  userId: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const logSchema = new mongoose.Schema({
  run: {
    signal: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    stdout: {
      type: String,
      default: '',
    },
    stderr: {
      type: String,
      default: '',
    },
    code: {
      type: Number,
    },
    output: {
      type: String,
    },
    memory: {
      type: Number,
      default: null,
    },
    message: {
      type: String,
    },
    status: {
      type: String,
    },
    cpu_time: {
      type: Number,
    },
    wall_time: {
      type: Number,
    },
  },
  language: {
    type: String,
  },
  version: {
    type: String,
  },
  session_id: {
    type: String,
  },
  files: [
    {
      id: {
        type: String,
      },
      name: {
        type: String,
      },
    },
  ],
  input: {
    type: String,
  },
  userId: {
    required: true,
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
logSchema.index({ userId: 1 });

const Log: mongoose.Model<
  ILog,
  object,
  object,
  object,
  mongoose.Document<unknown, object, ILog> &
    ILog & {
      _id: mongoose.Types.ObjectId;
    },
  unknown
> =
  (mongoose.models.Log as mongoose.Model<ILog> | undefined) ||
  mongoose.model<ILog>('Log', logSchema);

export default Log;
