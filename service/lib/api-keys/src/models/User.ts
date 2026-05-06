import mongoose, { Schema, Model } from 'mongoose';
import type { IUser, IValidationProps } from '@/types';
import toJSON from './plugins/toJSON';

const subscriptionSchema: Schema = new Schema({
  id: { type: String, required: true },
  status: { type: String, required: true },
  planId: { type: String, required: true },
  priceId: { type: String, required: true },
  currentPeriodEnd: { type: Date, required: true },
  cancelAtPeriodEnd: { type: Boolean, required: true },
  metadata: { type: Object, required: true },
});

const agreementSchema: Schema = new Schema({
  agreed: { type: Boolean, required: true },
  timestamp: { type: Date, required: true },
  version: { type: String, required: true },
  methodOfAgreement: { type: String, required: true },
  consentText: { type: String, required: true },
});

const userSchema: Schema = new Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      unique: true,
      validate: {
        validator: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: (props: IValidationProps) =>
          `${props.value} is not a valid email!`,
      },
    },
    password: {
      type: String,
      private: true,
    },
    resetToken: String,
    resetTokenExpiry: Date,
    image: {
      type: String,
    },
    usage: {
      type: Number,
      min: 0,
    },
    periodUsage: {
      type: Object,
      default: {},
    },
    newsletterActive: { type: Number },
    subscription: subscriptionSchema,
    stripeCustomerId: {
      type: String,
      validate: {
        validator: (v: string) => v.startsWith('cus_'),
        message: (props: IValidationProps) =>
          `${props.value} is not a valid customer ID!`,
      },
    },
    agreements: {
      termsOfService: agreementSchema,
      privacyPolicy: agreementSchema,
      refundPolicy: agreementSchema,
      deviceInfo: {
        type: String,
      },
      ipAddress: {
        type: String,
      },
    },
    enterprisePlans: {
      type: [String],
    },
    githubUsername: {
      type: String,
    },
    scopeMapName: {
      type: String,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

userSchema.plugin(toJSON);

const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', userSchema);

export default User;
