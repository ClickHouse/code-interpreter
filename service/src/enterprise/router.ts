import mongoose from 'mongoose';
import { Request, Response, NextFunction, Router } from 'express';
import {
  incrementUserApiUsage,
  incrementApiKeyUsage,
  validateAndGetUser,
  ENTERPRISE_PREFIX,
  validateApiKey,
  ErrorMessages,
  validateToken,
  TokenErrors,
  UserErrors,
} from '@librechat/api-keys';
import type { AuthenticatedRequest } from '../types';
import logger from '../logger';

export function enterpriseAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (mongoose.connection.readyState !== 1) {
    logger.error('Database connection is not established');
    res.status(503).json({
      error: 'Internal server error',
    });
    return;
  }

  const path = req.path.substring(1);
  if (path === 'user/id') {
    next();
    return;
  }

  const apiKeyString = req.header('x-api-key') ?? '';
  if (!apiKeyString.startsWith(ENTERPRISE_PREFIX)) {
    logger.error(`Invalid Enterprise API key: "${apiKeyString}" | Expected prefix: "${ENTERPRISE_PREFIX}"`);
    logger.debug('Invalid Enterprise Request headers:', req.headers);
    res.status(401).json({
      error: ErrorMessages.INVALID_API_KEY,
    });
  }
  next();
}

const router = Router();

router.use(enterpriseAuth);

router.get('/key', async (req: AuthenticatedRequest, res) => {
  try {
    const apiKeyString = req.header('x-api-key') ?? '';
    if (!apiKeyString) {
      logger.error('API key is required');
      return res.status(401).json({
        error: ErrorMessages.INVALID_API_KEY,
      });
    }

    const result = await validateApiKey(apiKeyString);
    res.json(result);
  } catch (error) {
    logger.error('Error validating API key', error);
    if (error instanceof Error && error.message.includes('Invalid API key')) {
      return res.status(401).json({
        error: ErrorMessages.INVALID_API_KEY,
      });
    }
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// GET /enterprise/user - Validate and get user
router.get('/user', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.apiKey?.userId;
    if (userId == null || userId === '') {
      logger.error('User not found');
      return res.status(400).json({
        error: ErrorMessages.USER_NOT_FOUND,
      });
    }

    const result = await validateAndGetUser(userId.toString());
    res.json(result);
  } catch (error) {
    logger.error('Error validating user', error);
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: ErrorMessages.USER_NOT_FOUND,
        });
      }
      if (error.message.includes('Invalid subscription')) {
        return res.status(403).json({
          error: ErrorMessages.INVALID_SUBSCRIPTION,
        });
      }
    }
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

router.get('/user/id', async (req: AuthenticatedRequest, res) => {
  try {
    const accessToken = req.header('x-access-token') ?? '';
    if (!accessToken) {
      logger.error('Access token is required');
      return res.status(401).json({
        error: ErrorMessages.ACCESS_TOKEN_NOT_PROVIDED,
      });
    }
    const result = await validateToken(accessToken);
    res.json(result);
  } catch (error) {
    logger.error('Error validating user from token', error);
    if (error instanceof Error) {
      if (error.message.includes(TokenErrors.INVALID_ACCESS_TOKEN)) {
        return res.status(404).json({
          error: ErrorMessages.INVALID_ACCESS_TOKEN,
        });
      }
      if (error.message.includes(UserErrors.INVALID_SUBSCRIPTION)) {
        return res.status(403).json({
          error: ErrorMessages.INVALID_SUBSCRIPTION,
        });
      }
    }
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// PATCH /enterprise/key/usage - Increment API key usage
router.patch('/key/usage', async (req: AuthenticatedRequest, res) => {
  try {
    const apiKey = req.apiKey;
    if (apiKey?._id == null || apiKey._id === '') {
      logger.error('API key is required');
      return res.status(400).json({
        error: ErrorMessages.INVALID_API_KEY,
      });
    }

    const result = await incrementApiKeyUsage(apiKey._id);
    res.json(result);
  } catch (error) {
    logger.error('Error incrementing API key usage', error);
    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        error: ErrorMessages.INVALID_API_KEY,
      });
    }
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// PATCH /enterprise/user/usage - Increment user usage
router.patch('/user/usage', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.apiKey?.userId;
    if (userId == null || userId === '') {
      logger.error('User not found');
      return res.status(400).json({
        error: ErrorMessages.USER_NOT_FOUND,
      });
    }

    const result = await incrementUserApiUsage(userId.toString());
    res.json(result);
  } catch (error) {
    logger.error('Error incrementing user usage', error);
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: ErrorMessages.USER_NOT_FOUND,
        });
      }
      if (error.message.includes('Usage limit exceeded')) {
        return res.status(403).json({
          error: ErrorMessages.USAGE_LIMIT_EXCEEDED,
        });
      }
    }
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

export default router;