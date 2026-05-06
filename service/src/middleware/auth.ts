// src/middleware/auth.ts
import { validateAndGetUser, validateUser, validateApiKey, ErrorMessages, UserErrors, KeyErrors } from '@librechat/api-keys';
import type { ServiceUser, IApiKey } from '@librechat/api-keys';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types';
import { connection } from '../queue';
import { isValidId } from '../utils';
import { env } from '../config';
import { resolveSessionKey } from '../session-key';
import logger from '../logger';

const checkUser = async (req: AuthenticatedRequest, userId: string): Promise<void> => {
  const cachedUser = await connection.get(`user:${userId}`) ?? '';
  const apiKeyString = req.header('X-API-Key') ?? '';
  if (!cachedUser) {
    const user = await validateAndGetUser(userId, apiKeyString);
    await connection.set(
      `user:${userId}`,
      JSON.stringify(user),
      'EX',
      env.USER_CACHE_TTL
    );
    return;
  }
  const user: ServiceUser | null | undefined = JSON.parse(cachedUser);
  if (user === null || user === undefined) {
    throw new Error('User not found');
  }
  const updatedUser = await validateUser(user);
  await connection.set(
    `user:${userId}`,
    JSON.stringify(updatedUser),
    'EX',
    env.USER_CACHE_TTL
  );
  req.planId = updatedUser.subscription?.planId;
  return;
};

const checkKeyLimit = (key: IApiKey): boolean => {
  const limit = key.limit ?? 0;
  if (!limit || limit <= 0) {
    return true;
  }
  const usage = key.usage ?? 0;
  return usage < limit;
};

const processApiKey = async (apiKeyString: string): Promise<IApiKey | null | undefined> => {
  const cachedKey = await connection.get(`apiKey:${apiKeyString}`) ?? '';
  if (!cachedKey) {
    const validatedKey = await validateApiKey(apiKeyString);
    const apiKey: IApiKey = {
      ...validatedKey,
      _id: validatedKey._id.toString(),
      userId: validatedKey.userId.toString(),
    };

    await connection.set(
      `apiKey:${apiKeyString}`,
      JSON.stringify(apiKey),
      'EX',
      env.KEY_CACHE_TTL
    );

    return apiKey;
  }

  return JSON.parse(cachedKey);
};

export const apiKeyAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> => {
  const path = req.path.substring(1);
  if (path === 'enterprise/user/id') {
    next();
    return;
  }
  const apiKeyString = req.header('X-API-Key') ?? '';

  if (!apiKeyString) {
    return res.status(401).json({ error: 'API key is required' });
  }

  try {
    const apiKey = await processApiKey(apiKeyString);
    if (!apiKey) {
      return res.status(401).json({ error: ErrorMessages.INVALID_API_KEY });
    }
    const userId = apiKey.userId.toString();

    if (!userId) {
      return res.status(401).json({ error: ErrorMessages.INVALID_API_KEY });
    }

    const accessUserId = await connection.get('access-user');
    if (accessUserId != null && accessUserId && accessUserId !== userId) {
      return res.status(401).json({ error: 'Unauthorized User' });
    }

    await checkUser(req, userId);
    const isWithinLimit = checkKeyLimit(apiKey);

    if (!isWithinLimit) {
      return res.status(429).json({ error: 'API key usage limit exceeded' });
    }

    req.apiKey = apiKey;
    next();
  } catch (error) {
    const message = ((error as Error | undefined)?.message ?? '') as UserErrors | KeyErrors;
    const errorMessage = ErrorMessages[message] || ErrorMessages.INVALID_API_KEY;
    logger.error(`API key validation error request from ${req.ip}:`, error);
    return res.status(401).json({ error: errorMessage });
  }
};

export const sessionAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void | Response> => {
  const { session_id, fileId } = req.params as { session_id?: string; fileId?: string };

  if (!isValidId(session_id)) {
    logger.error(`Invalid session ID: ${session_id}`);
    return res.status(400).json({ error: 'Bad request' });
  } else if (fileId != null && fileId.length > 0 && !isValidId(fileId)) {
    logger.error(`Invalid file ID: ${fileId}`);
    return res.status(400).json({ error: 'Bad request' });
  }

  const userId =  (req.apiKey?.userId ?? '').toString();
  if (!userId) {
    return res.status(401).json({ error: 'User not found' });
  }

  const { entity_id } = req.query;
  if (entity_id != null && typeof entity_id !== 'string') {
    return res.status(400).json({ error: 'Bad request' });
  }
  const sessionKey = resolveSessionKey(req, userId, entity_id);
  const cachedSessionKey = await connection.get(`session:${session_id}`);
  if (cachedSessionKey !== sessionKey) {
    logger.error(`Unauthorized download: Cached session key: ${cachedSessionKey} | Expected session key: ${sessionKey} | Session ID: ${session_id} | File ID: ${fileId}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }

  req.sessionKey = sessionKey;
  next();
};

const validPattern = /^[A-Za-z0-9_-]+$/;
export const validateEntityId = (req: Request, res: Response, next: NextFunction): void | Response => {
  // Check both query and body
  const entityId = req.query.entity_id ?? req.body.entity_id;

  // Skip validation if entity_id is undefined or null
  if (entityId == null) {
    return next();
  }

  // Check if entity_id is a string
  if (typeof entityId !== 'string') {
    return res.status(400).json({
      error: 'Invalid entity_id format',
      details: 'entity_id must be a string'
    });
  }

  // Check length
  if (entityId.length > 40) {
    return res.status(400).json({
      error: 'Invalid entity_id length',
      details: 'entity_id must not exceed 40 characters'
    });
  }

  // Check pattern: only alphanumeric characters, underscores, and hyphens
  const validPattern = /^[A-Za-z0-9_-]+$/;
  if (!validPattern.test(entityId)) {
    return res.status(400).json({
      error: 'Invalid entity_id format',
      details: 'entity_id must contain only alphanumeric characters, underscores, and hyphens'
    });
  }

  next();
};

// Helper function for busboy validation
export const validateEntityIdString = (entityId: string): boolean => {
  if (entityId.length > 40) {
    return false;
  }

  return validPattern.test(entityId);
};
