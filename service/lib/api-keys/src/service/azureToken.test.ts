// src/__tests__/azureToken.test.ts
import mongoose, { Types } from 'mongoose';
import { config as dotenvConfig } from 'dotenv';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContainerRegistryManagementClient } from '@azure/arm-containerregistry';
import type { IUser } from '../types';
import {
  getClient,
  listTokens,
  createToken,
  deleteToken,
  validateToken,
} from '../service/azureToken';
import { TokenErrors, UserErrors } from './enum';
import AzureToken from '../models/AzureToken';
import User from '../models/User';
import logger from '@/logger';

dotenvConfig();

const requiredEnvVars = [
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_RESOURCE_GROUP',
  'AZURE_ACR_NAME',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
];

jest.setTimeout(120000); // 2 minutes

async function cleanupTestTokens(
  client: ContainerRegistryManagementClient
): Promise<void> {
  try {
    const tokens = client.tokens.list(
      process.env.AZURE_RESOURCE_GROUP!,
      process.env.AZURE_ACR_NAME!
    );

    const deletePromises: Promise<void>[] = [];

    for await (const token of tokens) {
      if (token.name?.includes('test-token') === true) {
        deletePromises.push(
          client.tokens
            .beginDeleteAndWait(
              process.env.AZURE_RESOURCE_GROUP!,
              process.env.AZURE_ACR_NAME!,
              token.name
            )
            .then(() => {
              logger.info(`Cleaned up test token: ${token.name}`);
            })
        );
      }
    }

    // Wait for all deletions to complete with a timeout
    await Promise.race([
      Promise.all(deletePromises),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cleanup timeout')), 45000)
      ),
    ]);
  } catch (error) {
    logger.error('Error cleaning up test tokens:', error);
  }
}

describe('Azure Token Service', () => {
  let mongoServer: MongoMemoryServer;
  let testUser: IUser;
  let testTokenName: string;
  let createdTokenValue: string;
  let mongoConnection: typeof mongoose | null;
  let azureClient: ContainerRegistryManagementClient | null;

  beforeAll(async () => {
    // Check for required environment variables
    const missingVars = requiredEnvVars.filter(
      (varName) => process.env[varName] == null
    );
    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(', ')}`
      );
    }

    // Verify Azure client can be initialized
    const client = await getClient();
    if (!client) {
      throw new Error('Failed to initialize Azure client');
    }
    azureClient = client;

    // Clean up any leftover test tokens
    await cleanupTestTokens(azureClient);

    // Set up MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    mongoConnection = await mongoose.connect(mongoUri);

    // Create test user
    testUser = await User.create({
      _id: new Types.ObjectId(),
      name: 'Test User',
      email: 'test@example.com',
      subscription: {
        status: 'active',
        id: 'test-sub',
        planId: 'test-plan',
        priceId: 'test-price',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date(),
        metadata: {},
      },
      agreements: {
        termsOfService: {
          agreed: true,
          timestamp: new Date(),
          version: '1.0',
          methodOfAgreement: 'test',
          consentText: 'test',
        },
        privacyPolicy: {
          agreed: true,
          timestamp: new Date(),
          version: '1.0',
          methodOfAgreement: 'test',
          consentText: 'test',
        },
        refundPolicy: {
          agreed: true,
          timestamp: new Date(),
          version: '1.0',
          methodOfAgreement: 'test',
          consentText: 'test',
        },
        deviceInfo: 'test',
      },
    });
  }, 30000);

  afterAll(async () => {
    try {
      logger.info('Starting cleanup...');

      const cleanup = async (): Promise<void> => {
        if (azureClient) {
          await cleanupTestTokens(azureClient);
        }

        if (mongoConnection) {
          await Promise.all([mongoConnection.disconnect(), mongoServer.stop()]);
        }
      };

      // Add timeout to cleanup
      await Promise.race([
        cleanup(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Cleanup timeout')), 45000)
        ),
      ]);

      logger.info('Cleanup completed successfully');
    } catch (error) {
      logger.error('Error during cleanup:', error);
    }
  }, 60000);

  beforeEach(async () => {
    try {
      await Promise.all([
        AzureToken.deleteMany({}),
        User.updateOne(
          { _id: testUser._id },
          { 'subscription.status': 'active' }
        ),
      ]);
    } catch (error) {
      logger.error('Error in beforeEach:', error);
    }
  });

  describe('createToken', () => {
    it('should create a new token', async () => {
      testTokenName = `test-token-${Date.now()}`;
      const result = await createToken({
        userId: testUser._id,
        name: testTokenName,
        scope: 'pull',
      });

      expect(result.token).toBeDefined();
      expect(result.tokenDoc.userId).toEqual(testUser._id);
      expect(result.tokenDoc.name).toBe(testTokenName);

      createdTokenValue = result.token;
    }, 30000);

    it('should fail with non-existent user', async () => {
      const nonExistentUserId = new Types.ObjectId();
      await expect(
        createToken({
          userId: nonExistentUserId,
          name: 'test-token',
          scope: 'pull',
        })
      ).rejects.toThrow('User not found');
    });
  });

  describe('validateToken', () => {
    beforeEach(async () => {
      try {
        const result = await createToken({
          userId: testUser._id,
          name: `test-token-${Date.now()}`,
          scope: 'pull',
        });
        createdTokenValue = result.token;
      } catch (error) {
        logger.error('Error in validateToken beforeEach:', error);
        throw error;
      }
    }, 30000);

    it('should validate an existing token', async () => {
      const userId = await validateToken(createdTokenValue);
      expect(userId).toBe(testUser._id.toString());
    }, 30000);

    it('should fail with invalid token', async () => {
      await expect(validateToken('invalid-token')).rejects.toThrow(
        TokenErrors.INVALID_ACCESS_TOKEN
      );
    });

    it('should fail with inactive subscription', async () => {
      await User.updateOne(
        { _id: testUser._id },
        { 'subscription.status': 'inactive' }
      );

      await expect(validateToken(createdTokenValue)).rejects.toThrow(
        UserErrors.INVALID_SUBSCRIPTION
      );
    }, 10000);
  });

  describe('listTokens', () => {
    beforeEach(async () => {
      try {
        await Promise.all([
          createToken({
            userId: testUser._id,
            name: 'test-token-1',
            scope: 'pull',
          }),
          createToken({
            userId: testUser._id,
            name: 'test-token-2',
            scope: 'pull',
          }),
        ]);
      } catch (error) {
        logger.error('Error in listTokens beforeEach:', error);
        throw error;
      }
    }, 30000);

    it('should list all tokens for user', async () => {
      const tokens = await listTokens(testUser._id.toString());
      expect(tokens).toHaveLength(2);
      expect(tokens.map((t) => t.name)).toContain('test-token-1');
      expect(tokens.map((t) => t.name)).toContain('test-token-2');
    }, 10000);

    it('should return empty array for user with no tokens', async () => {
      const nonExistentUserId = new Types.ObjectId();
      const tokens = await listTokens(nonExistentUserId.toString());
      expect(tokens).toHaveLength(0);
    });
  });

  describe('deleteToken', () => {
    beforeEach(async () => {
      try {
        await createToken({
          userId: testUser._id,
          name: 'test-token-to-delete',
          scope: 'pull',
        });
        testTokenName = 'test-token-to-delete';
      } catch (error) {
        logger.error('Error in deleteToken beforeEach:', error);
        throw error;
      }
    }, 30000);

    it('should delete an existing token', async () => {
      const result = await deleteToken(testUser._id.toString(), testTokenName);
      expect(result).toBe(true);

      const tokens = await listTokens(testUser._id.toString());
      expect(tokens).toHaveLength(0);
    }, 30000);

    it('should return false for non-existent token', async () => {
      const result = await deleteToken(
        testUser._id.toString(),
        'non-existent-token'
      );
      expect(result).toBe(false);
    }, 10000);

    it('should return false for non-existent user', async () => {
      const nonExistentUserId = new Types.ObjectId();
      const result = await deleteToken(
        nonExistentUserId.toString(),
        testTokenName
      );
      expect(result).toBe(false);
    }, 10000);
  });
});
