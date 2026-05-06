// models/AzureToken.ts
import mongoose, { Schema } from 'mongoose';
import type { IAzureToken } from '../types';

export const AzureTokenSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    token: { type: String, required: true, unique: true, index: true },
    scope: {
      type: String,
      enum: ['pull', 'push', 'pull,push'],
      default: 'pull',
    },
    lastUsedAt: { type: Date },
    expiration: { type: Date },
  },
  { timestamps: true }
);

AzureTokenSchema.index({ userId: 1, name: 1 }, { unique: true });
AzureTokenSchema.index({ expiration: 1 }, { expireAfterSeconds: 0 });

const AzureToken: mongoose.Model<IAzureToken> =
  mongoose.models.AzureToken ||
  mongoose.model<IAzureToken>('AzureToken', AzureTokenSchema);

export default AzureToken;
