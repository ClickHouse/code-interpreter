import { Types } from 'mongoose';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import type {
  ICreateApiKeyInput,
  IUpdateApiKeyInput,
  ICheckApiKeyLimit,
  IApiKeyResponse,
  ICacheProvider,
  IApiKeyID,
  IApiKey,
} from '../types';
import { validateInput } from '../inputValidator';
import { CustomError } from '../errorHandler';
import { remoteProcess } from './remote';
import ApiKey from '../models/ApiKey';
import { KeyErrors } from './enum';
import config from '../config';
import logger from '../logger';

let cacheProvider: ICacheProvider | null = null;

export const setCacheProvider = (provider: ICacheProvider): void => {
  cacheProvider = provider;
};

export const generateApiKey = (prefix?: string): string => {
  const apiKeyPrefix = prefix ?? config.PREFIX;
  const randomBytesLength = config.API_KEY_LENGTH - apiKeyPrefix.length;
  const randomPart = randomBytes(randomBytesLength)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, randomBytesLength);
  const apiKeyWithoutChecksum = apiKeyPrefix + randomPart;
  const checksum = createHash('sha256')
    .update(apiKeyWithoutChecksum)
    .digest('hex')
    .slice(0, config.CHECKSUM_LENGTH);
  return `${apiKeyWithoutChecksum}${config.CHECKSUM_PREFIX}${checksum}`;
};

export const createApiKey = async (
  input: ICreateApiKeyInput
): Promise<IApiKeyResponse> => {
  const cleanedInput = { ...input };
  if (cleanedInput.expiration === null) {
    delete cleanedInput.expiration;
  }
  if (cleanedInput.limit === null) {
    delete cleanedInput.limit;
  }

  const validatedInput = validateInput(cleanedInput, 'createApiKey');

  let apiKey: string;
  let hash: string;
  let existingApiKey: IApiKey | null;

  do {
    apiKey = generateApiKey(
      cleanedInput.isEnterprise === true ? config.ENTERPRISE_PREFIX : undefined
    );
    hash = createHash('sha256').update(apiKey).digest('hex');
    existingApiKey = await ApiKey.findOne({ secret: hash });
    if (existingApiKey) {
      logger.warn(`Duplicate key found: ${hash}, regenerating...`);
    }
  } while (existingApiKey);

  const apiKeyDoc = new ApiKey({
    ...validatedInput,
    usage: 0,
    secret: hash,
    lastUsedAt: new Date(),
  });

  try {
    await apiKeyDoc.save();
  } catch (error) {
    logger.error('Error creating API key:', error);
    throw error;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, ...apiKeyDocWithoutSecret } = apiKeyDoc.toObject();

  return {
    apiKey,
    apiKeyDoc: apiKeyDocWithoutSecret,
  };
};

export const validateApiKey = async (
  apiKeyString: string
): Promise<IApiKey> => {
  const remoteKey = await remoteProcess<IApiKey>(apiKeyString, 'key', 'GET');
  if (remoteKey) {
    return remoteKey;
  }
  validateInput({ apiKeyString }, 'validateApiKey');
  if (
    !config.VALID_PREFIXES.some((prefix) => apiKeyString.startsWith(prefix))
  ) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  }

  const lastUnderscoreIndex = apiKeyString.lastIndexOf('_');
  if (lastUnderscoreIndex === -1) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  }

  const checksum = apiKeyString.slice(lastUnderscoreIndex + 1);

  if (!checksum) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  } else if (checksum.length !== config.CHECKSUM_LENGTH) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  }

  const apiKeyWithoutChecksum = apiKeyString.slice(0, lastUnderscoreIndex);

  const calculatedChecksum = createHash('sha256')
    .update(apiKeyWithoutChecksum)
    .digest('hex')
    .slice(0, config.CHECKSUM_LENGTH);

  if (calculatedChecksum.length !== config.CHECKSUM_LENGTH) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  }

  if (
    !timingSafeEqual(
      new Uint8Array(Buffer.from(checksum)),
      new Uint8Array(Buffer.from(calculatedChecksum))
    )
  ) {
    throw new CustomError(KeyErrors.INVALID_API_KEY, 401);
  }

  const hash = createHash('sha256').update(apiKeyString).digest('hex');
  if (cacheProvider) {
    const cachedApiKey = await cacheProvider.get(`apiKey:${hash}`);
    if (cachedApiKey !== null && cachedApiKey !== undefined) {
      return JSON.parse(cachedApiKey);
    }
  }

  const apiKey = await ApiKey.findOne({ secret: hash })
    .select('+secret')
    .lean();

  if (!apiKey) {
    throw new CustomError('Invalid API key', 401);
  }

  if (cacheProvider) {
    await cacheProvider.set(`apiKey:${hash}`, JSON.stringify(apiKey), 3600);
  }

  return apiKey;
};

export const incrementApiKeyUsage = async (
  apiKeyId: Types.ObjectId | string,
  apiKeyString?: string
): Promise<IApiKey> => {
  const remoteKey = await remoteProcess<IApiKey>(
    apiKeyString ?? '',
    'key/usage',
    'PATCH'
  );
  if (remoteKey) {
    return remoteKey;
  }
  validateInput({ apiKeyId: apiKeyId.toString() }, 'incrementApiKeyUsage');

  const apiKey = await ApiKey.findByIdAndUpdate(
    apiKeyId,
    {
      lastUsedAt: new Date(),
      $inc: { usage: 1 },
    },
    { new: true, select: '-secret -__v' }
  ).lean();
  if (!apiKey) {
    throw new CustomError('API key not found', 404);
  }
  return apiKey;
};

export const checkApiKeyLimit = async (
  apiKey: ICheckApiKeyLimit
): Promise<boolean> => {
  if (apiKey.limit === 0) return true;

  const doc = await ApiKey.findById(apiKey._id).select('usage').lean();
  if (!doc) return false;
  const currentUsage = doc.usage || 0;
  return currentUsage < apiKey.limit;
};

export const deleteApiKey = async (apiKey: IApiKeyID): Promise<boolean> => {
  validateInput(
    { apiKeyId: apiKey._id, userId: apiKey.userId },
    'deleteApiKey'
  );

  const result = await ApiKey.deleteOne({
    _id: apiKey._id,
    userId: apiKey.userId,
  });
  return result.deletedCount === 1;
};

export const listApiKeys = async (
  userId: IApiKey['userId']
): Promise<IApiKey[]> => {
  validateInput({ userId: userId.toString() }, 'listApiKeys');

  return await ApiKey.find({ userId }).select('-secret -__v').lean();
};

export const getApiKeyDetails = async (
  apiKeyId: IApiKey['_id'],
  userId: IApiKey['userId']
): Promise<IApiKey | null> => {
  validateInput(
    { apiKeyId: apiKeyId.toString(), userId: userId.toString() },
    'getApiKeyDetails'
  );

  const apiKey = await ApiKey.findOne({ _id: apiKeyId, userId })
    .select('-secret -__v')
    .lean();
  return !apiKey ? null : apiKey;
};

export const updateApiKey = async (
  userId: IApiKey['userId'],
  updates: IUpdateApiKeyInput
): Promise<IApiKey | null> => {
  validateInput(
    { apiKeyId: updates._id, userId: userId.toString(), updates },
    'updateApiKey'
  );

  const unsetFields: Record<string, unknown> = {};

  if (updates.expiration === null) {
    delete updates.expiration;
    unsetFields.expiration = '';
  }
  if (updates.limit === null) {
    delete updates.limit;
    unsetFields.limit = '';
  }

  const updateOperation: {
    $set: Partial<IUpdateApiKeyInput>;
    $unset?: Record<string, unknown>;
  } = { $set: updates };
  if (Object.keys(unsetFields).length > 0) {
    updateOperation.$unset = unsetFields;
  }

  const apiKey = await ApiKey.findOneAndUpdate(
    { _id: updates._id, userId },
    updateOperation,
    { new: true, select: '-secret -__v' }
  );

  return !apiKey ? null : apiKey;
};

export const checkUserApiKeyLimit = async (
  userId: IApiKey['userId'],
  maxKeys: number
): Promise<boolean> => {
  validateInput({ userId: userId.toString(), maxKeys }, 'checkUserApiKeyLimit');

  const count = await ApiKey.countDocuments({ userId });
  return count < maxKeys;
};

export const deleteApiKeysForUser = async (
  userId: IApiKey['userId']
): Promise<number> => {
  validateInput({ userId: userId.toString() }, 'deleteApiKeysForUser');

  const result = await ApiKey.deleteMany({ userId });
  return result.deletedCount;
};
