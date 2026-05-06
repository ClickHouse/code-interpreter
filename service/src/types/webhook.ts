import type { Stripe } from 'stripe';

export interface WebhookJobData {
  event: Stripe.Event;
  timestamp: number;
}

export type SupportedEventType =
  | 'checkout.session.completed'
  | 'invoice.paid'
  | 'customer.subscription.updated'
  | 'invoice.payment_failed'
  | 'customer.subscription.deleted'
  | 'customer.subscription.trial_will_end'
  | 'invoice.payment_succeeded'
  | 'customer.subscription.paused'
  | 'invoice.marked_uncollectible'
  | 'charge.refunded'
  | 'customer.updated'
  | 'customer.deleted'
  | 'invoice.created'
  | 'invoice.finalized'
  | 'customer.subscription.created'
  | 'payment_method.attached'
  | 'payment_method.detached';
