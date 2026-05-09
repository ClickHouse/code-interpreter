// src/middleware/auth.ts
import rateLimitFactory from 'express-rate-limit';
import RateLimitRedisStore from 'rate-limit-redis';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import type { SendCommandFn, RedisReply } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { connection } from '../queue';
import { env } from '../config';

const sendCommand: SendCommandFn = async (command: string, ...args: (string | number | Buffer)[]): Promise<RedisReply> => {
  const result = await connection.call(command, ...args);
  return result as RedisReply;
};

export const keyGenerator = (req: Request): string => {
  const authReq = req as AuthenticatedRequest;
  const principal = authReq.codeApiPrincipal;
  if (principal?.userId) {
    return `${principal.tenantId}:${principal.userId}`;
  }
  if (authReq.codeApiAuthContext?.userId) {
    return `${authReq.codeApiAuthContext.tenantId ?? 'legacy'}:${authReq.codeApiAuthContext.userId}`;
  }
  return (authReq.apiKey?.userId ?? req.ip ?? '').toString();
};

export const createRateLimiter = (
  prefix: string,
  windowMs: number,
  max: number,
  customMessage?: string
): RateLimitRequestHandler => {
  return rateLimitFactory({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RateLimitRedisStore({
      sendCommand,
      prefix: `${prefix}:`
    }),
    keyGenerator,
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        error: customMessage ?? 'Too many requests, please try again later.',
      });
    },
  });
};

export const executionLimiter = createRateLimiter(
  'exec',
  env.EXEC_LIMIT_WINDOW,
  env.EXEC_MAX_REQUESTS,
  'Too many code execution requests, please try again later.'
);

export const uploadLimiter = createRateLimiter(
  'upload',
  env.UPLOAD_LIMIT_WINDOW,
  env.UPLOAD_MAX_REQUESTS,
  'Too many file uploads, please try again later.'
);

export const downloadLimiter = createRateLimiter(
  'download',
  env.DOWNLOAD_LIMIT_WINDOW,
  env.DOWNLOAD_MAX_REQUESTS,
  'Too many file downloads, please try again later.'
);

export const fetchLimiter = createRateLimiter(
  'fetch',
  env.FETCH_LIMIT_WINDOW,
  env.FETCH_MAX_REQUESTS,
  'Too many file list requests, please try again later.'
);
