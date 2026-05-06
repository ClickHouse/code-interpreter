// src/webhook/handler.ts
import Stripe from 'stripe';
import mongoose from 'mongoose';
import { Invoice, updateUser, getUserByStripeCustomerId, getUserById, listTokens, createToken } from '@librechat/api-keys';
import type { IUser, ISubscription  } from '@librechat/api-keys';
import { isEnterpriseUser, sanitizeTokenName } from './util';
import type { SupportedEventType } from '../types';
import { EmailService } from '../emails/service';
import { webhookQueue } from '../queue';
import { env } from '../config';
import logger from '../logger';

const { INSTANCE_ID } = env;

const STRIPE_API_VERSION = (process.env.STRIPE_API_VERSION ?? '2024-11-20.acacia');
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION as '2024-11-20.acacia',
    typescript: true,
  })
  : undefined;

export class StripeWebhookHandler {
  // eslint-disable-next-line no-unused-vars
  static eventHandlers: Record<SupportedEventType, ((event: Stripe.Event) => Promise<void>) | undefined> =
    {
      // Checkout & Initial Setup Events
      'checkout.session.completed': StripeWebhookHandler.handleCheckoutSessionCompleted,

      // Subscription Lifecycle Events
      'customer.subscription.created': StripeWebhookHandler.handleCustomerSubscriptionCreated,
      'customer.subscription.updated': StripeWebhookHandler.handleCustomerSubscriptionUpdated,
      'customer.subscription.deleted': StripeWebhookHandler.handleCustomerSubscriptionDeleted,
      'customer.subscription.paused': StripeWebhookHandler.handleCustomerSubscriptionPaused,
      'customer.subscription.trial_will_end':
        StripeWebhookHandler.handleCustomerSubscriptionTrialWillEnd,

      // Invoice & Payment Events
      'invoice.created': StripeWebhookHandler.handleInvoiceCreated,
      'invoice.finalized': StripeWebhookHandler.handleInvoiceFinalized,
      'invoice.paid': StripeWebhookHandler.handleInvoicePaid,
      'invoice.payment_succeeded': StripeWebhookHandler.handleInvoicePaymentSucceeded,
      'invoice.payment_failed': StripeWebhookHandler.handleInvoicePaymentFailed,
      'invoice.marked_uncollectible': StripeWebhookHandler.handleInvoiceMarkedUncollectible,
      'charge.refunded': StripeWebhookHandler.handleChargeRefunded,

      // Customer Account Events
      'customer.updated': StripeWebhookHandler.handleCustomerUpdated,
      'customer.deleted': StripeWebhookHandler.handleCustomerDeleted,

      // Payment Method Events
      'payment_method.attached': StripeWebhookHandler.handlePaymentMethodAttached,
      'payment_method.detached': StripeWebhookHandler.handlePaymentMethodDetached,
    };

  /**
   * Core webhook handling methods
   */
  public static async handleWebhook(body: string, signature: string): Promise<void> {
    try {
      const event = await StripeWebhookHandler.verifyStripeWebhook(body, signature);

      const handler = StripeWebhookHandler.eventHandlers[event.type as SupportedEventType];
      if (!handler) {
        logger.warn(`[${INSTANCE_ID}] No handler for event type: ${event.type}`);
        return;
      }
      logger.info(`[${INSTANCE_ID}] Adding "${event.type}" event to queue`);

      await webhookQueue.add(
        event.type,
        { event, timestamp: event.created },
        {
          priority: StripeWebhookHandler.getEventPriority(event.type),
          jobId: event.id,
        }
      );
    } catch (error: unknown) {
      logger.error('Error in webhook handler:', error);
      throw new Error('Error in webhook handler');
    }
  }

  private static getEventPriority(eventType: string): number {
    const priorities: Record<string, number> = {
      // Customer Events (Highest Priority)
      'customer.created': 1,
      'customer.updated': 2,
      'customer.deleted': 3,

      // Payment Method Events
      'payment_method.attached': 4,
      'payment_method.detached': 5,

      // Subscription Creation Flow
      'customer.subscription.created': 10,
      'customer.subscription.updated': 11, // Including status changes (incomplete → active)
      'customer.subscription.trial_will_end': 12,
      'customer.subscription.paused': 13,
      'customer.subscription.deleted': 14,

      // Checkout Events
      'checkout.session.completed': 20,
      'checkout.session.async_payment_succeeded': 21,
      'checkout.session.async_payment_failed': 22,

      // Invoice Flow
      'invoice.created': 30,
      'invoice.finalized': 31,
      'invoice.updated': 32,
      'invoice.paid': 33,
      'invoice.payment_succeeded': 34,
      'invoice.payment_failed': 35,
      'invoice.marked_uncollectible': 36,

      // Refund/Dispute Events
      'charge.refunded': 40,
      'charge.dispute.created': 41,
      'charge.dispute.updated': 42,
      'charge.dispute.closed': 43,

      // Default priority for unspecified events
      'default': 100
    };

    return priorities[eventType] || priorities.default;
  }

  private static async verifyStripeWebhook(body: string, signature: string): Promise<Stripe.Event> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    try {
      return await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err: unknown) {
      logger.error('Webhook signature verification failed:', err);
      throw new Error('Webhook signature verification failed');
    }
  }

  /**
   * Checkout & Initial Setup Events
   */

  private static async handleCheckoutSessionCompleted(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id ?? '';
    if (!userId) {
      throw new Error('No user ID found');
    }
    const customerId = session.customer as string;
    const subscriptionId = session.subscription as string;

    const user = await UserService.findOrCreateUser(userId, customerId, session.customer_details);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ID ${customerId} for ${event.type}`);
      throw new Error('No user found');
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);

    await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
      metadata: {
        planId: session.metadata?.planId ?? '',
        startDate: new Date().toISOString(),
      },
    });

    await UserService.updateUserSubscription(user, customerId, subscription, plan);
    logger.info(`[${INSTANCE_ID}] Checkout session completed for user ${user._id}`);
  }

  /**
   * Subscription Lifecycle Events
   */

  private static async handleCustomerSubscriptionCreated(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const subscriptionData = event.data.object as Stripe.Subscription;
    const customerId = subscriptionData.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ID ${customerId} for ${event.type}`);
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionData.id);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);
    const product = await stripe.products.retrieve(plan.product as string);

    await Promise.all([
      UserService.updateUserSubscription(user, customerId, subscription, plan, product),
      EmailService.sendSubscriptionCreated(user.email, product.name),
    ]);
  }

  private static async handleCustomerSubscriptionUpdated(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const subscriptionData = event.data.object as Stripe.Subscription;
    const previousAttributes = event.data.previous_attributes as Partial<Stripe.Subscription>;
    const customerId = subscriptionData.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ID: ${customerId}`);
      return;
    }

    const plan = await stripe.plans.retrieve(subscriptionData.items.data[0].plan.id);
    const subscription = await stripe.subscriptions.retrieve(subscriptionData.id);

    if (previousAttributes.status === 'incomplete' && subscription.status === 'active') {
      logger.info(`[${INSTANCE_ID}] Subscription ${subscription.id} activation change for customer ${customerId}`);
    }

    try {
      await UserService.updateUserSubscription(user, customerId, subscription, plan);
      logger.info(`[${INSTANCE_ID}] Updated subscription for user ${user._id}`);
    } catch (error) {
      logger.error(`[${INSTANCE_ID}] Failed to update subscription for user ${user._id}:`, error);
      throw error;
    }
  }

  private static async handleCustomerSubscriptionDeleted(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const subscriptionData = event.data.object as Stripe.Subscription;
    const customerId = subscriptionData.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionData.id);
    const latestInvoice = (await stripe.invoices.retrieve(subscription.latest_invoice as string)) as Stripe.Response<Stripe.Invoice> | undefined;
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);
    if (latestInvoice) {
      await Promise.all([
        BillingService.addToInvoicesHistory(user._id.toString(), latestInvoice, plan, 'void'),
        Invoice.findOneAndUpdate(
          { stripeInvoiceId: latestInvoice.id },
          { status: 'void' },
          { new: true },
        ),
        BillingService.createOrUpdateInvoice(user._id.toString(), latestInvoice),
        EmailService.sendSubscriptionCanceled(user.email),
      ]);
    }

    await UserService.updateUserSubscription(user, customerId, subscription, plan);
    logger.info(`[${INSTANCE_ID}] Subscription ${subscription.id} canceled for customer ${customerId}`);
  }

  private static async handleCustomerSubscriptionPaused(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    if (user.subscription) {
      await updateUser(user._id.toString(), {
        subscription: {
          ...user.subscription,
          status: 'paused',
        },
      });
      logger.info(`[${INSTANCE_ID}] Subscription ${subscription.id} paused for customer ${customerId}`);
    }

    // TODO: Implement any additional logic for paused subscriptions
  }

  private static async handleCustomerSubscriptionTrialWillEnd(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    // TODO: Send email to user
  }

  /**
   * Invoice & Payment Events
   */

  private static async handleInvoiceCreated(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const invoiceData = event.data.object as Stripe.Invoice;
    const user = await getUserByStripeCustomerId(invoiceData.customer as string);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${invoiceData.customer} for ${event.type}`);
      return;
    }

    const invoice = await stripe.invoices.retrieve(invoiceData.id);
    await BillingService.createOrUpdateInvoice(user._id.toString(), invoice);
    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} created for customer ${invoice.customer}`);
  }

  private static async handleInvoiceFinalized(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    const user = await getUserByStripeCustomerId(invoice.customer as string);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${invoice.customer} for ${event.type}`);
      return;
    }

    await Invoice.findOneAndUpdate(
      { stripeInvoiceId: invoice.id },
      { status: invoice.status },
      { upsert: true },
    );
    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} finalized for customer ${invoice.customer}`);
  }

  private static async handleInvoicePaid(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const invoiceData = event.data.object as Stripe.Invoice;
    const customerId = invoiceData.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user || !user.subscription) {
      logger.warn(`[${INSTANCE_ID}] No user or subscription found for customer ${customerId} for ${event.type}`);
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(invoiceData.subscription as string);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);
    const invoice = await stripe.invoices.retrieve(invoiceData.id);

    await updateUser(user._id.toString(), {
      subscription: {
        ...user.subscription,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
    });

    await Promise.all([
      BillingService.addToInvoicesHistory(user._id.toString(), invoice, plan),
      BillingService.createOrUpdateInvoice(user._id.toString(), invoice),
    ]);

    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} payment succeeded for customer ${customerId}`);
  }

  private static async handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const invoiceData = event.data.object as Stripe.Invoice;
    const customerId = invoiceData.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user || !user.subscription) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    const invoice = await stripe.invoices.retrieve(invoiceData.id);
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);

    await updateUser(user._id.toString(), {
      subscription: {
        ...user.subscription,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
    });

    await Promise.all([
      BillingService.addToInvoicesHistory(user._id.toString(), invoice, plan),
      BillingService.createOrUpdateInvoice(user._id.toString(), invoice),
    ]);

    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} payment succeeded for customer ${customerId}`);
  }

  private static async handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const invoice = event.data.object as Stripe.Invoice;
    const customerId = invoice.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);

    await Promise.all([
      BillingService.addToInvoicesHistory(user._id.toString(), invoice, plan, 'uncollectible'),
      Invoice.findOneAndUpdate(
        { stripeInvoiceId: invoice.id },
        { status: 'uncollectible' },
        { new: true },
      ),
      BillingService.createOrUpdateInvoice(user._id.toString(), invoice),
      EmailService.sendPaymentFailed(user.email, invoice.amount_due, invoice.currency),
    ]);

    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} payment failed for customer ${customerId}`);
  }

  private static async handleInvoiceMarkedUncollectible(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const invoice = event.data.object as Stripe.Invoice;
    const customerId = invoice.customer as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customerId} for ${event.type}`);
      return;
    }

    if (user.subscription) {
      updateUser(user._id.toString(), {
        subscription: {
          ...user.subscription,
          status: 'past_due',
        },
      });
    }

    const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
    const plan = await stripe.plans.retrieve(subscription.items.data[0].plan.id);

    await Promise.all([
      BillingService.addToInvoicesHistory(user._id.toString(), invoice, plan, 'uncollectible'),
      BillingService.createOrUpdateInvoice(user._id.toString(), invoice),
    ]);

    logger.info(`[${INSTANCE_ID}] Invoice ${invoice.id} marked uncollectible for customer ${customerId}`);
  }

  private static async handleChargeRefunded(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const charge = event.data.object as Stripe.Charge;
    const customerId = charge.customer as string;
    const invoiceId = charge.invoice as string;

    const user = await getUserByStripeCustomerId(customerId);
    if (!user || !invoiceId) {
      logger.warn(`[${INSTANCE_ID}] User or invoice ID ${invoiceId} not found for customer ${customerId} for ${event.type}`);
      return;
    }

    const invoice = await stripe.invoices.retrieve(invoiceId);
    const subscription = invoice.subscription != null
      ? await stripe.subscriptions.retrieve(invoice.subscription as string)
      : null;
    const plan = subscription
      ? await stripe.plans.retrieve(subscription.items.data[0].plan.id)
      : null;

    if (!plan) {
      logger.warn(`[${INSTANCE_ID}] Plan not found for invoice ${invoiceId} for customer ${customerId}`);
      return;
    }

    await stripe.invoices.update(invoiceId, {
      metadata: { status: 'refunded' },
    });

    await Promise.all([
      BillingService.addToInvoicesHistory(user._id.toString(), invoice, plan, 'refunded'),
      Invoice.findOneAndUpdate(
        { stripeInvoiceId: invoice.id },
        {
          status: 'refunded',
          refundedAt: new Date(),
          refundAmount: charge.amount_refunded,
        },
        { new: true },
      ),

      updateUser(user._id.toString(), {
        subscription: {
          ...(user.subscription as ISubscription),
          status: 'canceled',
        },
      }),

      EmailService.sendRefundIssued(user.email, charge.amount_refunded, charge.currency),
    ]);

    logger.info(`[${INSTANCE_ID}] Charge ${charge.id} refunded for customer ${customerId}`);
  }

  /**
   * Customer Account Events
   */
  private static async handleCustomerUpdated(event: Stripe.Event): Promise<void> {
    const customer = event.data.object as Stripe.Customer;
    const user = await getUserByStripeCustomerId(customer.id);
    if (!user) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ${customer.id} for ${event.type}`);
      return;
    }

    const updateData: Partial<{ email: string; name: string }> = {};

    if (customer.email != null && customer.email && customer.email !== user.email) {
      updateData.email = customer.email;
    }

    if (customer.name != null && customer.name && customer.name !== user.name) {
      updateData.name = customer.name;
    }

    if (Object.keys(updateData).length > 0) {
      await updateUser(user._id.toString(), updateData);
    }

    logger.info(`[${INSTANCE_ID}] Customer ${customer.id} updated`);
  }

  private static async handleCustomerDeleted(event: Stripe.Event): Promise<void> {
    const customer = event.data.object as Stripe.Customer;

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await updateUser(customer.id as string, {stripeCustomerId: null,subscription: null });

    logger.info(`[${INSTANCE_ID}] Customer ${customer.id} deleted`);
  }

  /**
   * Payment Method Events
   */
  private static async handlePaymentMethodAttached(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const paymentMethod = event.data.object as Stripe.PaymentMethod;
    const customerId = paymentMethod.customer as string;

    const customer = await stripe.customers.retrieve(customerId);

    if ('deleted' in customer) {
      logger.warn(`[${INSTANCE_ID}] Customer ${customerId} deleted before payment method ${paymentMethod.id} attached`);
      return;
    }

    if (customer.invoice_settings.default_payment_method == null) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethod.id },
      });
      logger.info(`[${INSTANCE_ID}] Payment method ${paymentMethod.id} attached to customer ${customerId}`);
    } else {
      logger.info(`[${INSTANCE_ID}] Payment method ${paymentMethod.id} already attached to customer ${customerId}: ${customer.invoice_settings.default_payment_method}`);
    }
  }

  private static async handlePaymentMethodDetached(event: Stripe.Event): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const paymentMethod = event.data.object as Stripe.PaymentMethod;
    const customerId = paymentMethod.customer as string;

    const customer = await stripe.customers.retrieve(customerId);

    if ('deleted' in customer) {
      logger.warn(`[${INSTANCE_ID}] Customer ${customerId} deleted before payment method ${paymentMethod.id} detached`);
      return;
    }

    if (customer.invoice_settings.default_payment_method === paymentMethod.id) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });

      if (paymentMethods.data.length > 0) {
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethods.data[0].id },
        });
      }

      logger.info(`[${INSTANCE_ID}] Payment method ${paymentMethod.id} detached from customer ${customerId}`);
    }
  }
}

class UserService {
  public static async createEnterpriseToken(user: IUser): Promise<void> {
    try {
      const tokens = await listTokens(user._id.toString());
      if (tokens.length > 0) {
        logger.info(`Enterprise token already exists for user: ${user._id}`);
        return;
      }

      const token = await createToken({
        userId: user._id.toString(),
        name: sanitizeTokenName(user.email),
        scopeMapName: user.scopeMapName,
      });
      logger.info(`Created enterprise token for user: ${user._id} | Registry username: ${token.tokenDoc.name}`);
    } catch (error) {
      logger.error(`Failed to create enterprise token for user: ${user._id}:`, error);
    }
  }

  public static async updateUserSubscription(
    user: IUser,
    customerId: string,
    subscription: Stripe.Subscription,
    plan: Stripe.Plan,
    _product?: Stripe.Product,
  ): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const product = _product ?? (await stripe.products.retrieve(plan.product as string));
    const isEnterpriseSub = isEnterpriseUser(user);
    if (isEnterpriseSub) {
      await this.createEnterpriseToken(user);
    }

    // Ensure Date type for currentPeriodEnd
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

    // Explicitly type the subscription data
    const subscriptionData: IUser['subscription'] = {
      id: subscription.id,
      status: subscription.status,
      planId: plan.product as string,
      priceId: subscription.items.data[0].price.id,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      metadata: product.metadata,
    };

    try {
      await updateUser(user._id.toString(), {
        stripeCustomerId: customerId,
        subscription: subscriptionData,
      });
      logger.info(`[${INSTANCE_ID}] Successfully updated subscription for user ${user._id}`);
    } catch (error) {
      logger.error('Failed to update user subscription:', error);
      throw error;
    }
  }

  public static async findOrCreateUser(
    _userId: string | undefined,
    customerId: string,
    customerDetails: Stripe.Checkout.Session.CustomerDetails | null,
  ): Promise<IUser | null> {
    let user = await getUserByStripeCustomerId(customerId);
    const userId = _userId ?? '';
    if (!user && userId) {
      user = await getUserById(userId);
    }

    if (!user && customerDetails?.email != null) {
      logger.warn(`[${INSTANCE_ID}] No user found for customer ID ${customerId} or user ID ${userId}`);
      return null;
    }

    const userCustomerId = user?.stripeCustomerId ?? '';

    if (user && !userCustomerId) {
      await updateUser(user._id.toString(), {
        stripeCustomerId: customerId,
      });
      user = await getUserByStripeCustomerId(customerId);
    }

    // Ensure the subscription date is a Date object
    if (user?.subscription?.currentPeriodEnd != null) {
      user.subscription.currentPeriodEnd = new Date(user.subscription.currentPeriodEnd);
    }

    return user as IUser;
  }
}

type MongooseError = mongoose.Error & { code?: number };
class BillingService {
  private static readonly STATUS_PRIORITY: Record<string, number> = {
    'paid': 4,
    'refunded': 3,
    'open': 2,
    'draft': 1,
    'void': 0,
    'uncollectible': 0
  } as const;

  public static async addToInvoicesHistory(
    userId: string,
    source: Stripe.Invoice,
    plan: Stripe.Plan,
    status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'refunded' = 'paid',
  ): Promise<void> {
    const invoiceData = {
      userId: new mongoose.Types.ObjectId(userId),
      stripeInvoiceId: source.id,
      status,
      date: new Date(source.created * 1000),
      customerEmail: source.customer_email ?? '',
      amount: source.amount_paid || source.amount_due,
      currency: source.currency,
      planId: plan.product as string,
      priceId: plan.id,
      description:
        source.lines.data[0]?.description ?? `Subscription to ${plan.nickname ?? 'plan'}`,
      dueDate: source.due_date != null ? new Date(source.due_date * 1000) : undefined,
      discounts: source.total_discount_amounts?.reduce((acc, curr) => acc + curr.amount, 0),
      tax: source.tax,
    };

    const existingInvoice = await Invoice.findOne({
      stripeInvoiceId: source.id
    });

    if (existingInvoice != null) {
      const existingPriority = this.STATUS_PRIORITY[existingInvoice.status] || 0;
      const newPriority = this.STATUS_PRIORITY[status] ?? 0;

      if (newPriority > existingPriority) {
        await Invoice.findOneAndUpdate(
          { stripeInvoiceId: source.id },
          invoiceData,
          { new: true }
        );
        logger.info(`[${INSTANCE_ID}] Updated existing invoice ${source.id} for user ${userId}`);
      }
    } else {
      try {
        await Invoice.create(invoiceData);
        logger.info(`[${INSTANCE_ID}] Created new invoice ${source.id} for user ${userId}`);
      } catch (_error) {
        const error = _error as MongooseError;
        if (error.code != null && error.code !== 11000) {
          throw error;
        }
        logger.info(`[${INSTANCE_ID}] Duplicate invoice creation attempted for ${source.id}`);
      }
    }
  }

  public static async createOrUpdateInvoice(
    userId: string,
    stripeInvoice: Stripe.Invoice,
  ): Promise<void> {
    if (!stripe) {
      throw new Error('Stripe client not initialized');
    }
    const planId = stripeInvoice.lines.data[0]?.plan?.id ?? '';
    const plan = await stripe.plans.retrieve(planId);

    const productId = plan.product;
    const product = await stripe.products.retrieve(productId as string);

    const status = (stripeInvoice.status as keyof typeof this.STATUS_PRIORITY | null) ?? 'draft';
    const invoiceData = {
      userId: new mongoose.Types.ObjectId(userId).toString(),
      stripeInvoiceId: stripeInvoice.id,
      status,
      date: new Date(stripeInvoice.created * 1000),
      customerEmail: stripeInvoice.customer_email ?? '',
      amount: stripeInvoice.amount_paid,
      currency: stripeInvoice.currency,
      planId: planId,
      priceId: stripeInvoice.lines.data[0]?.price?.id ?? '',
      metadata: product.metadata,
    };

    const existingInvoice = await Invoice.findOne({
      stripeInvoiceId: stripeInvoice.id
    });

    if (existingInvoice != null) {
      logger.info(`[${INSTANCE_ID}] Updating existing invoice ${stripeInvoice.id} for user ${userId}`);
      const existingPriority = this.STATUS_PRIORITY[existingInvoice.status] || 0;
      const newPriority = this.STATUS_PRIORITY[status] ?? 0;

      if (newPriority > existingPriority) {
        await Invoice.findOneAndUpdate(
          { stripeInvoiceId: stripeInvoice.id },
          invoiceData,
          { new: true }
        );
      }
    } else {
      logger.info(`[${INSTANCE_ID}] Creating new invoice ${stripeInvoice.id} for user ${userId}`);
      await Invoice.create(invoiceData);
    }
  }
}