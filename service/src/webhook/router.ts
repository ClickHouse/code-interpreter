// webhook/router.ts
import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import { StripeWebhookHandler } from './handler';
import logger from '../logger';

const router = Router();

router.post('/stripe', raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] ?? '';

    if (signature.length === 0 || typeof signature !== 'string') {
      logger.error('Missing or invalid Stripe signature');
      return res.status(400).json({ error: 'Missing or invalid Stripe signature' });
    }

    const rawBody = req.body;
    if (rawBody === null || rawBody === undefined || rawBody.length === 0) {
      logger.error('Missing request body');
      return res.status(400).json({ error: 'Missing request body' });
    }

    logger.debug('Received Stripe webhook:', {
      signature,
      bodyPreview: rawBody.toString('utf8').slice(0, 100) + '...'
    });

    await StripeWebhookHandler.handleWebhook(rawBody.toString('utf8'), signature);

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook processing failed:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;