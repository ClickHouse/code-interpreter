import mongoose from 'mongoose';

const webhookJobSchema = new mongoose.Schema({
  stripeEventId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    default: 'pending',
  },
  timestamp: { type: Number, required: true },
  processedAt: Date,
  error: String,
  stackTrace: String,
  message: String,
  attempts: { type: Number, default: 0 },
}, {
  timestamps: true,
  index: { timestamp: 1 },
});

export const WebhookJob = mongoose.model('WebhookJob', webhookJobSchema);