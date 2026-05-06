import crypto from 'crypto';
import { Token, User, getUserById, updateUser } from '@librechat/api-keys';
import type { IUser, IToken } from '@librechat/api-keys';
import { EmailService } from '../emails/service';
import { env } from '../config';
import logger from '../logger';

const { INSTANCE_ID } = env;

export class NewsletterService {
  static async verifySignature(signature: string, payload: string): Promise<boolean> {
    const expectedSignature = crypto
      .createHmac('sha256', env.NEWSLETTER_SECRET)
      .update(payload)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  static generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static async initiateSignup(email: string): Promise<void> {
    const user: IUser | null = await User.findOne({ email });
    if (!user) {
      logger.error(`[${INSTANCE_ID}][/signup] User not found for newsletter signup: ${email}`);
      throw new Error('User not found');
    }

    if (typeof user.newsletterActive === 'number' && user.newsletterActive > 0) {
      logger.warn(`[${INSTANCE_ID}][/signup] User already subscribed to newsletter: ${email}`);
      throw new Error('Already subscribed to newsletter');
    }

    const token = this.generateToken();
    const verificationUrl = `https://${env.DOMAIN_NAME}/newsletter/verify/${token}`;

    await Token.create({
      userId: user._id,
      email,
      token,
      createdAt: new Date(),
    });

    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        Please confirm your newsletter subscription by clicking the button below:
      </p>
      <div class="button-container" style="margin-top:2rem; text-align:center" align="center">
        <a href="${verificationUrl}" class="button" style="background-color:rgb(99, 102, 241); border-radius:0.375rem; color:white; display:inline-block; font-weight:500; padding:0.75rem 1.5rem; text-decoration:none">
          Confirm Subscription
        </a>
      </div>
    `;

    logger.info(`[${INSTANCE_ID}][/signup] Sending newsletter signup email to: ${email}`);
    await EmailService.sendNewsletterSignup(email, content);
  }

  static async verifySignup(token: string): Promise<void> {
    const tokenDoc: IToken | null = await Token.findOne({ token });
    if (!tokenDoc) {
      logger.error(`[${INSTANCE_ID}][/verify] Invalid or expired token: ${token}`);
      throw new Error('Invalid or expired token');
    }

    const user = await getUserById(tokenDoc.userId.toString());
    if (!user) {
      logger.error(`[${INSTANCE_ID}][/verify] User not found for newsletter verification: ${tokenDoc.userId}`);
      throw new Error('User not found');
    }

    await updateUser(user._id, { newsletterActive: Date.now() });
    await Token.deleteOne({ _id: tokenDoc._id });

    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        Your newsletter subscription has been confirmed. Welcome to our community!
      </p>
    `;

    logger.info(`[${INSTANCE_ID}][/verify] Sending newsletter welcome email to: ${user.email}`);
    await EmailService.sendNewsletterWelcome(user.email, content);
  }

  static async unsubscribe(userId: string): Promise<void> {
    const user = await getUserById(userId);
    if (!user || typeof user.newsletterActive !== 'number' || user.newsletterActive === 0) {
      logger.error(`[${INSTANCE_ID}][/unsubscribe] User not found or not subscribed: ${userId}`);
      throw new Error('User not found or not subscribed');
    }

    await updateUser(userId, { newsletterActive: 0 });

    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        You have been successfully unsubscribed from our newsletter. We're sorry to see you go!
      </p>
    `;

    logger.info(`[${INSTANCE_ID}][/unsubscribe] Sending newsletter unsubscribe email to: ${user.email}`);
    await EmailService.sendNewsletterUnsubscribe(user.email, content);
  }
}