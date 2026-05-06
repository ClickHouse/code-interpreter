import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import {
  generateApiKey,
  createApiKey,
  validateApiKey,
  incrementApiKeyUsage,
  checkApiKeyLimit,
  deleteApiKey,
  listApiKeys,
  getApiKeyDetails,
  updateApiKey,
  checkUserApiKeyLimit,
  deleteApiKeysForUser,
  setCacheProvider,
} from '..';
import ApiKey from '../models/ApiKey';
import { KeyErrors } from './enum';
import config from '../config';

let mongoServer: MongoMemoryServer;

const mockCacheProvider = {
  get: jest.fn(),
  set: jest.fn(),
};

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }

  await mongoServer.stop();
});

describe('API Key Management', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ApiKey.deleteMany({});
    jest.clearAllMocks();
  });

  describe('generateApiKey', () => {
    it('should generate a valid API key', () => {
      const apiKey = generateApiKey();
      const prefix = config.PREFIX;
      const randomPartLength = config.API_KEY_LENGTH - prefix.length;
      const checksumLength = config.CHECKSUM_LENGTH;
      const regex = new RegExp(
        `^${prefix}[A-Za-z0-9]{${randomPartLength}}${config.CHECKSUM_PREFIX}[A-Fa-f0-9]{${checksumLength}}$`
      );
      expect(apiKey).toMatch(regex);
    });

    it('should generate a valid enterprise API key when enterprise prefix is provided', () => {
      const apiKey = generateApiKey(config.ENTERPRISE_PREFIX);
      const prefix = config.ENTERPRISE_PREFIX;
      const randomPartLength = config.API_KEY_LENGTH - prefix.length;
      const checksumLength = config.CHECKSUM_LENGTH;
      const regex = new RegExp(
        `^${prefix}[A-Za-z0-9]{${randomPartLength}}${config.CHECKSUM_PREFIX}[A-Fa-f0-9]{${checksumLength}}$`
      );
      expect(apiKey).toMatch(regex);
    });
  });

  describe('createApiKey', () => {
    it('should create a new API key with all optional fields', async () => {
      const input = {
        userId: new Types.ObjectId(),
        name: 'Test Key',
        expiration: new Date(Date.now() + 86400000),
        limit: 100,
      };
      const result = await createApiKey(input);

      expect(result).toHaveProperty('apiKey');
      expect(result).toHaveProperty('apiKeyDoc');
      expect(result.apiKeyDoc.name).toBe('Test Key');
      expect(result.apiKeyDoc.limit).toBe(100);
      expect(result.apiKeyDoc.expiration).toBeDefined();
    });

    it('should handle duplicate API keys by regenerating', async () => {
      const userId = new Types.ObjectId();
      const firstResult = await createApiKey({
        userId,
        name: 'First Key',
      });

      // Create second key (should have different key value)
      const secondResult = await createApiKey({
        userId,
        name: 'Second Key',
      });

      expect(firstResult.apiKey).not.toBe(secondResult.apiKey);
      expect(firstResult.apiKeyDoc._id).not.toEqual(secondResult.apiKeyDoc._id);
    });

    it('should create an enterprise API key when isEnterprise is true', async () => {
      const input = {
        userId: new Types.ObjectId(),
        name: 'Enterprise Key',
        isEnterprise: true,
      };

      const result = await createApiKey(input);

      expect(result.apiKey.startsWith(config.ENTERPRISE_PREFIX)).toBe(true);
      expect(result.apiKeyDoc.isEnterprise).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    it('should validate a correct API key', async () => {
      const { apiKey, apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
      });
      const result = await validateApiKey(apiKey);

      expect(result._id).toEqual(apiKeyDoc._id);
      expect(result).toHaveProperty('secret');
    });

    it('should throw an error for an invalid API key format (no checksum)', async () => {
      await expect(validateApiKey('invalidKey')).rejects.toThrow(
        KeyErrors.INVALID_API_KEY
      );
    });

    it('should throw an error for an invalid API key format (wrong prefix)', async () => {
      const invalidApiKey = `WRONG${config.PREFIX.slice(5)}${'a'.repeat(
        config.API_KEY_LENGTH -
          config.PREFIX.length -
          config.CHECKSUM_LENGTH -
          1
      )}.validchecksum`;
      await expect(validateApiKey(invalidApiKey)).rejects.toThrow(
        KeyErrors.INVALID_API_KEY
      );
    });

    it('should throw an error for an invalid API key checksum', async () => {
      const validPrefix = config.PREFIX;
      const validLength =
        config.API_KEY_LENGTH -
        config.PREFIX.length -
        config.CHECKSUM_LENGTH -
        1;
      const invalidApiKey = `${validPrefix}${'a'.repeat(
        validLength
      )}.invalidchecksum`;
      await expect(validateApiKey(invalidApiKey)).rejects.toThrow(
        KeyErrors.INVALID_API_KEY
      );
    });

    it('should throw an error for a non-existent API key', async () => {
      const validFormatApiKey = generateApiKey();
      await expect(validateApiKey(validFormatApiKey)).rejects.toThrow(
        'Invalid API key'
      );
    });

    it('should validate an enterprise API key', async () => {
      const { apiKey, apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Enterprise Key',
        isEnterprise: true,
      });

      const result = await validateApiKey(apiKey);

      expect(result._id).toEqual(apiKeyDoc._id);
      expect(result.isEnterprise).toBe(true);
      expect(apiKey.startsWith(config.ENTERPRISE_PREFIX)).toBe(true);
    });

    it('should reject API key with invalid enterprise prefix', async () => {
      const invalidPrefix = 'sk-invalid-ent_';
      const invalidApiKey = `${invalidPrefix}${'a'.repeat(
        config.API_KEY_LENGTH - invalidPrefix.length
      )}${config.CHECKSUM_PREFIX}12345678`;

      await expect(validateApiKey(invalidApiKey)).rejects.toThrow(
        KeyErrors.INVALID_API_KEY
      );
    });
  });

  describe('incrementApiKeyUsage', () => {
    it('should increment API key usage and update all fields', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
        limit: 100,
        expiration: new Date(Date.now() + 86400000),
      });

      const result = await incrementApiKeyUsage(apiKeyDoc._id);

      expect(result.usage).toBe(1);
      expect(result).toHaveProperty('userId');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('lastUsedAt');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('expiration');
      expect(result).not.toHaveProperty('secret');

      const secondResult = await incrementApiKeyUsage(apiKeyDoc._id);
      expect(secondResult.usage).toBe(2);
    });

    it('should throw error for non-existent API key', async () => {
      const nonExistentId = new Types.ObjectId();
      await expect(incrementApiKeyUsage(nonExistentId)).rejects.toThrow(
        'API key not found'
      );
    });

    it('should increment enterprise API key usage correctly', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Enterprise Key',
        isEnterprise: true,
        limit: 100,
      });

      const result = await incrementApiKeyUsage(apiKeyDoc._id);

      expect(result.usage).toBe(1);
      expect(result.isEnterprise).toBe(true);

      const secondResult = await incrementApiKeyUsage(apiKeyDoc._id);
      expect(secondResult.usage).toBe(2);
    });
  });

  describe('checkApiKeyLimit', () => {
    it('should return true if usage is within limit', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
        limit: 100,
      });

      const apiKeyWithLimit = {
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      };

      await incrementApiKeyUsage(apiKeyDoc._id);
      const result = await checkApiKeyLimit(apiKeyWithLimit);

      expect(result).toBe(true);
    });

    it('should return false if usage exceeds limit', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
        limit: 1,
      });

      // First increment
      await incrementApiKeyUsage(apiKeyDoc._id);
      // Second increment to exceed limit
      await incrementApiKeyUsage(apiKeyDoc._id);

      const apiKeyWithLimit = {
        _id: apiKeyDoc._id,
        limit: 1, // Set explicit limit of 1
      };

      const result = await checkApiKeyLimit(apiKeyWithLimit);
      expect(result).toBe(false);
    });

    it('should return true when limit is 0 (unlimited)', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
        limit: 0,
      });

      const result = await checkApiKeyLimit({
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      });
      expect(result).toBe(true);
    });

    it('should check enterprise API key limit correctly', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Enterprise Key',
        isEnterprise: true,
        limit: 2,
      });

      // Initial check
      let result = await checkApiKeyLimit({
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      });
      expect(result).toBe(true);

      // After first usage
      await incrementApiKeyUsage(apiKeyDoc._id);
      result = await checkApiKeyLimit({
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      });
      expect(result).toBe(true);

      // After second usage (reaching limit)
      await incrementApiKeyUsage(apiKeyDoc._id);
      result = await checkApiKeyLimit({
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      });
      expect(result).toBe(false);
    });

    it('should handle unlimited enterprise API key correctly', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Unlimited Enterprise Key',
        isEnterprise: true,
        limit: 0, // 0 means unlimited
      });

      // Use the key multiple times
      await incrementApiKeyUsage(apiKeyDoc._id);
      await incrementApiKeyUsage(apiKeyDoc._id);
      await incrementApiKeyUsage(apiKeyDoc._id);

      const result = await checkApiKeyLimit({
        _id: apiKeyDoc._id,
        limit: apiKeyDoc.limit ?? 0,
      });
      expect(result).toBe(true);
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
      });

      const result = await deleteApiKey({
        _id: apiKeyDoc._id,
        userId: apiKeyDoc.userId,
      });

      expect(result).toBe(true);
      const deletedKey = await ApiKey.findById(apiKeyDoc._id);
      expect(deletedKey).toBeNull();
    });

    it('should return false when API key not found', async () => {
      const result = await deleteApiKey({
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
      });

      expect(result).toBe(false);
    });
  });

  describe('listApiKeys', () => {
    it('should list API keys for a user', async () => {
      const userId = new Types.ObjectId();
      await createApiKey({ userId, name: 'Key 1' });
      await createApiKey({ userId, name: 'Key 2' });

      const result = await listApiKeys(userId);

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('name', 'Key 1');
      expect(result[1]).toHaveProperty('name', 'Key 2');
      expect(result[0]).not.toHaveProperty('secret');
      expect(result[1]).not.toHaveProperty('secret');
    });

    it('should return empty array for user with no keys', async () => {
      const result = await listApiKeys(new Types.ObjectId());
      expect(result).toEqual([]);
    });
  });

  describe('getApiKeyDetails', () => {
    it('should get details of an API key', async () => {
      const userId = new Types.ObjectId();
      const { apiKeyDoc } = await createApiKey({
        userId,
        name: 'Test Key',
      });

      const result = await getApiKeyDetails(apiKeyDoc._id, userId);
      expect(result).toHaveProperty('name', 'Test Key');
      expect(result).toHaveProperty('userId');
      expect(result).not.toHaveProperty('secret');
    });

    it('should return null when API key not found', async () => {
      const result = await getApiKeyDetails(
        new Types.ObjectId(),
        new Types.ObjectId()
      );
      expect(result).toBeNull();
    });

    it('should return null when API key belongs to different user', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
      });

      const result = await getApiKeyDetails(
        apiKeyDoc._id,
        new Types.ObjectId()
      );
      expect(result).toBeNull();
    });
  });

  describe('updateApiKey', () => {
    it('should update an API key with all fields', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Original Name',
        limit: 100,
        expiration: new Date(Date.now() + 86400000),
      });

      const newExpiration = new Date(Date.now() + 172800000); // +48 hours
      const result = await updateApiKey(apiKeyDoc.userId, {
        _id: apiKeyDoc._id,
        name: 'Updated Name',
        limit: 200,
        expiration: newExpiration,
      });

      expect(result?.name).toBe('Updated Name');
      expect(result?.limit).toBe(200);
      expect(result?.expiration?.getTime()).toBe(newExpiration.getTime());
    });

    it('should remove optional fields when set to null', async () => {
      // First create an API key with limit and expiration
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Original Name',
        limit: 100,
        expiration: new Date(Date.now() + 86400000),
      });

      // Update with null values
      await updateApiKey(apiKeyDoc.userId as Types.ObjectId, {
        _id: apiKeyDoc._id,
        name: 'Updated Name',
        limit: null,
        expiration: null,
      });

      // Fetch the updated document directly to verify
      const updatedDoc = await ApiKey.findById(apiKeyDoc._id).lean();

      expect(updatedDoc?.name).toBe('Updated Name');
      expect(updatedDoc?.limit).toBeUndefined();
      expect(updatedDoc?.expiration).toBeUndefined();
    });

    it('should return null when API key not found', async () => {
      const result = await updateApiKey(new Types.ObjectId(), {
        _id: new Types.ObjectId(),
        name: 'Updated Name',
      });

      expect(result).toBeNull();
    });

    it('should return null when API key belongs to different user', async () => {
      const { apiKeyDoc } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Original Name',
      });

      const result = await updateApiKey(new Types.ObjectId(), {
        _id: apiKeyDoc._id,
        name: 'Updated Name',
      });

      expect(result).toBeNull();
    });
  });

  describe('checkUserApiKeyLimit', () => {
    it('should return true if user is within API key limit', async () => {
      const userId = new Types.ObjectId();
      await createApiKey({ userId, name: 'Key 1' });
      await createApiKey({ userId, name: 'Key 2' });

      const result = await checkUserApiKeyLimit(userId, 5);
      expect(result).toBe(true);
    });

    it('should return false if user exceeds API key limit', async () => {
      const userId = new Types.ObjectId();
      await createApiKey({ userId, name: 'Key 1' });
      await createApiKey({ userId, name: 'Key 2' });
      await createApiKey({ userId, name: 'Key 3' });

      const result = await checkUserApiKeyLimit(userId, 2);
      expect(result).toBe(false);
    });

    it('should handle case with no existing keys', async () => {
      const result = await checkUserApiKeyLimit(new Types.ObjectId(), 1);
      expect(result).toBe(true);
    });
  });

  describe('deleteApiKeysForUser', () => {
    it('should delete all API keys for a user', async () => {
      const userId = new Types.ObjectId();
      await createApiKey({ userId, name: 'Key 1' });
      await createApiKey({ userId, name: 'Key 2' });
      await createApiKey({ userId, name: 'Key 3' });

      const otherUserId = new Types.ObjectId();
      await createApiKey({ userId: otherUserId, name: 'Other Key' });

      const deletedCount = await deleteApiKeysForUser(userId);

      expect(deletedCount).toBe(3);
      const remainingKeys = await ApiKey.find({ userId });
      expect(remainingKeys).toHaveLength(0);

      const otherUserKeys = await ApiKey.find({ userId: otherUserId });
      expect(otherUserKeys).toHaveLength(1);
    });

    it('should return 0 when user has no API keys', async () => {
      const userId = new Types.ObjectId();
      const deletedCount = await deleteApiKeysForUser(userId);
      expect(deletedCount).toBe(0);
    });

    it('should throw validation error for invalid userId format', async () => {
      await expect(deleteApiKeysForUser('invalid-id')).rejects.toThrow();
    });
  });

  describe('setCacheProvider', () => {
    it('should set the cache provider and use it for validation', async () => {
      setCacheProvider(mockCacheProvider);
      const { apiKey } = await createApiKey({
        userId: new Types.ObjectId(),
        name: 'Test Key',
      });

      mockCacheProvider.get.mockResolvedValueOnce(null);
      await validateApiKey(apiKey);

      expect(mockCacheProvider.get).toHaveBeenCalled();
      expect(mockCacheProvider.set).toHaveBeenCalled();
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        3600
      );
    });
  });
});
