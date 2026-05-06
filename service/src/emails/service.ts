// src/emails/service.ts
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config';
import logger from '../logger';

const transport: Transporter | undefined = env.EMAIL_SERVER
  ? createTransport(env.EMAIL_SERVER)
  : undefined;
const { host } = new URL('https://' + env.DOMAIN_NAME);

export class EmailService {
  private static async sendEmail(to: string, subject: string, content: string): Promise<void> {
    if (!transport) {
      logger.error('Email server is not configured');
      return;
    }
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
          <title>${subject}</title>
          <style>.button:hover {background-color:rgb(79, 70, 229)}
          .footer a:hover {color:rgb(79, 70, 229)}</style>
        </head>
        <body>
          <div class="container" style="background-color:rgb(249, 250, 251); font-family:ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont; padding:2rem" bgcolor="rgb(249, 250, 251)">
            <div class="card" style="background-color:white; border-radius:0.5rem; margin:0 auto; max-width:28rem; padding:2rem" bgcolor="white">
              <div class="icon-container" style="align-items:center; border-radius:9999px; display:flex; height:80px; justify-content:center; margin:0 auto; width:80px" bgcolor="rgb(238, 242, 255)" height="80px" width="80px">
                <img src="https://raw.githubusercontent.com/LibreChat-AI/librechat.ai/refs/heads/main/public/librechat.png" alt="LibreChat logo" style="height:80px; width:80px">
              </div>
              <h1 class="heading" style="color:rgb(17, 24, 39); font-size:1.875rem; font-weight:700; margin-top:1.5rem; text-align:center" align="center">${subject}</h1>
              ${content}
            </div>
          </div>
        </body>
      </html>
    `;

    await transport.sendMail({
      to,
      from: env.FROM_NO_REPLY_EMAIL,
      subject,
      html,
      text: `${subject}\n\n${content}\n\nVisit the LibreChat Platform for more details.\n\n`,
    });
  }

  static async sendSubscriptionCreated(email: string, planName: string): Promise<void> {
    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        Thank you for subscribing to the ${planName}! Your subscription has been activated successfully.
      </p>
      <div class="footer" style="color:rgb(107, 114, 128); font-size:0.75rem; margin-top:2rem; text-align:center" align="center">
        <p>
          Visit our 
          <a href="${host}/invoices" style="color:rgb(99, 102, 241); font-weight:500; text-decoration:none">invoices page</a> for more details.
        </p>
        <p>Best, The LibreChat team</p>
      </div>
    `;
    await this.sendEmail(email, 'Subscription Activated', content);
  }

  static async sendSubscriptionCanceled(email: string): Promise<void> {
    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        Your subscription has been canceled. You'll continue to have access until the end of your billing period.
      </p>
    `;
    await this.sendEmail(email, 'Subscription Canceled', content);
  }

  static async sendPaymentFailed(email: string, amount: number, currency: string): Promise<void> {
    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        Your payment of ${amount / 100} ${currency.toUpperCase()} has failed. Please update your payment method to continue using our services.
      </p>
    `;
    await this.sendEmail(email, 'Payment Failed', content);
  }

  static async sendRefundIssued(email: string, amount: number, currency: string): Promise<void> {
    const content = `
      <p class="description" style="color:rgb(75, 85, 99); font-size:0.875rem; margin-top:0.5rem; text-align:center" align="center">
        A refund of ${amount / 100} ${currency.toUpperCase()} has been issued to your account.
      </p>
    `;
    await this.sendEmail(email, 'Refund Issued', content);
  }

  static async sendNewsletterSignup(email: string, content: string): Promise<void> {
    await this.sendEmail(email, 'Confirm Newsletter Subscription', content);
  }

  static async sendNewsletterWelcome(email: string, content: string): Promise<void> {
    await this.sendEmail(email, 'Welcome to Our Newsletter!', content);
  }

  static async sendNewsletterUnsubscribe(email: string, content: string): Promise<void> {
    await this.sendEmail(email, 'Newsletter Unsubscription Confirmed', content);
  }
}