import mongoose, { Schema } from 'mongoose';
import toJSON from './plugins/toJSON';
import { IInvoice } from '@/types';

const invoiceSchema: Schema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    stripeInvoiceId: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'open', 'paid', 'uncollectible', 'void', 'refunded'],
    },
    planId: {
      type: String,
      required: true,
    },
    priceId: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
    },
    customerEmail: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    dueDate: {
      type: Date,
    },
    discounts: {
      type: Number,
      min: 0,
    },
    tax: {
      type: Number,
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

invoiceSchema.plugin(toJSON);

const Invoice: mongoose.Model<IInvoice> =
  mongoose.models.Invoice || mongoose.model<IInvoice>('Invoice', invoiceSchema);

export default Invoice;
