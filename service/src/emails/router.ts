import { Router } from 'express';
import { NewsletterService } from './newsletter';
import logger from '../logger';
import { env } from '../config';

const { INSTANCE_ID } = env;

const router = Router();

router.post('/signup', async (req, res) => {
  try {
    const { email } = req.body;
    const signature = req.headers['x-newsletter-signature'];

    if (signature == null || typeof signature !== 'string') {
      logger.warn(`[${INSTANCE_ID}][/signup] Missing newsletter signature from ${req.ip}`);
      return res.status(401).json({ error: 'Missing signature' });
    }

    const isValid = await NewsletterService.verifySignature(
      signature,
      JSON.stringify(req.body)
    );

    if (!isValid) {
      logger.warn(`[${INSTANCE_ID}][/signup] Invalid newsletter signature from ${req.ip}: ${signature}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    await NewsletterService.initiateSignup(email);
    logger.info(`[${INSTANCE_ID}][/signup] Newsletter signup initiated for: ${email}`);
    res.status(200).json({ message: 'Verification email sent' });
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'User not found') {
      return res.status(404).json({ error: message });
    }
    res.status(400).json({ error: message });
  }
});

router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    await NewsletterService.verifySignup(token);
    logger.info(`[${INSTANCE_ID}][/verify] Newsletter subscription confirmed for token: ${token}`);
    res.status(200).json({ message: 'Newsletter subscription confirmed' });
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'User not found') {
      logger.error('[/verify] User not found for newsletter signup');
      return res.status(404).json({ error: message });
    }
    logger.error(`[${INSTANCE_ID}][/verify] Error verifying newsletter signup: ${message}`);
    res.status(400).json({ error: message });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { userId } = req.body;
    const signature = req.headers['x-newsletter-signature'];

    if (signature == null || typeof signature !== 'string') {
      logger.warn(`[${INSTANCE_ID}][/unsubscribe] Missing newsletter signature from ${req.ip}`);
      return res.status(401).json({ error: 'Missing signature' });
    }

    const isValid = await NewsletterService.verifySignature(
      signature,
      JSON.stringify(req.body)
    );

    if (!isValid) {
      logger.warn(`[${INSTANCE_ID}][/unsubscribe] Invalid newsletter signature from ${req.ip}: ${signature}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    await NewsletterService.unsubscribe(userId);
    logger.info(`[${INSTANCE_ID}][/unsubscribe] Newsletter unsubscribed for user: ${userId}`);
    res.status(200).json({ message: 'Successfully unsubscribed' });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('User not found')) {
      logger.error('[/unsubscribe] User not found for newsletter unsubscribe');
      return res.status(404).json({ error: message });
    }
    logger.error(`[${INSTANCE_ID}][/unsubscribe] Error unsubscribing from newsletter: ${message}`);
    res.status(400).json({ error: message });
  }
});

export default router;