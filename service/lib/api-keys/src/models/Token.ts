import mongoose, { Schema, Model } from 'mongoose';
import type { IToken } from '@/types';
import toJSON from './plugins/toJSON';

const tokenSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'user',
  },
  email: {
    type: String,
  },
  token: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
});
tokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 172800 });

tokenSchema.plugin(toJSON);

const Token: Model<IToken> =
  mongoose.models.Token || mongoose.model<IToken>('Token', tokenSchema);

export default Token;
