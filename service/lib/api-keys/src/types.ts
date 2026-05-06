import { Types } from 'mongoose';
import type { Stripe } from 'stripe';

export interface IValidationProps {
  value: string;
}

export interface ISubscription {
  id: string;
  status: Stripe.Subscription.Status;
  planId: string;
  priceId: string;
  currentPeriodEnd?: Date | string;
  cancelAtPeriodEnd: boolean;
  metadata?: Record<string, string>;
}

export interface IAgreementRecord {
  agreed: boolean;
  timestamp: Date;
  version: string;
  methodOfAgreement: string;
  consentText: string;
}

export interface IAgreements {
  termsOfService: IAgreementRecord;
  privacyPolicy: IAgreementRecord;
  refundPolicy: IAgreementRecord;
  deviceInfo: string;
  ipAddress?: string;
}

export interface IInvoice {
  _id: string;
  userId: Types.ObjectId;
  stripeInvoiceId: string;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'refunded';
  date: Date;
  customerEmail: string;
  amount: number;
  currency: string;
  planId: string;
  priceId: string;
  description?: string;
  dueDate?: Date;
  discounts?: number;
  tax?: number;
}

export interface IUser {
  _id: string;
  name: string;
  email: string;
  password?: string;
  resetToken?: string;
  resetTokenExpiry?: Date;
  image?: string;
  newsletterActive?: number;
  usage?: number;
  periodUsage?: Record<string, number | undefined>;
  subscription?: ISubscription;
  stripeCustomerId?: string;
  agreements: IAgreements;
  enterprisePlans?: string[];
  githubUsername?: string;
  scopeMapName?: string;
  save: () => Promise<IUser>;
}

export interface IToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  email: string;
  token: string;
  createdAt: Date;
}

export interface IApiKey {
  _id: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  name: string;
  secret: string;
  usage: number;
  limit?: number;
  lastUsedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiration?: Date;
  isEnterprise?: boolean;
}

export type IApiKeyData = Pick<
  IApiKey,
  '_id' | 'userId' | 'name' | 'usage' | 'limit' | 'expiration' | 'isEnterprise'
>;

export interface ICreateApiKeyInput {
  userId: IApiKey['userId'];
  name: string;
  limit?: number | null;
  expiration?: Date | null;
  isEnterprise?: IApiKey['isEnterprise'];
}

export interface IUpdateApiKeyInput extends Partial<ICreateApiKeyInput> {
  _id: IApiKey['_id'];
}

export type IApiKeyID = Pick<IApiKey, '_id' | 'userId'>;

export interface IApiKeyResponse {
  apiKey: string;
  apiKeyDoc: Omit<IApiKeyData, 'secret'>;
}

export type ICheckApiKeyLimit = Required<Pick<IApiKey, '_id' | 'limit'>>;

export interface ICacheProvider {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttl: number): Promise<void>;
}

export type ServiceUser = Pick<
  IUser,
  '_id' | 'subscription' | 'usage' | 'periodUsage' | 'enterprisePlans'
>;

export interface ErrorDetails {
  message: string;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  code?: string;
}

export interface IAzureToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  token: string;
  scope: 'pull' | 'push' | 'pull,push';
  lastUsedAt?: Date;
  expiration?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateTokenInput {
  userId: Types.ObjectId | string;
  name: string;
  scope?: 'pull' | 'push' | 'pull,push';
  scopeMapName?: string;
  expiration?: Date;
}

export interface ITokenResponse {
  token: string;
  tokenDoc: Omit<IAzureToken, 'token'>;
}
