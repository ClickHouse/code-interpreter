import mongoose, { Schema } from 'mongoose';
import type { IApiKey } from '../types';

export const ApiKeySchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    secret: { type: String, required: true, unique: true, index: true },
    usage: { type: Number, default: 0 },
    limit: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
    expiration: { type: Date },
    isEnterprise: { type: Boolean },
  },
  { timestamps: true }
);

ApiKeySchema.index({ userId: 1, name: 1 }, { unique: true });
ApiKeySchema.index({ expiration: 1 }, { expireAfterSeconds: 0 });

const ApiKey: mongoose.Model<IApiKey> =
  mongoose.models.ApiKey || mongoose.model<IApiKey>('ApiKey', ApiKeySchema);

export default ApiKey;
