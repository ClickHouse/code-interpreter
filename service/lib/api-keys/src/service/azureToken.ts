import { delay } from '@azure/core-util';
import { ContainerRegistryManagementClient } from '@azure/arm-containerregistry';
import {
  ClientSecretCredential,
  DefaultAzureCredential,
  AzureCliCredential,
  ChainedTokenCredential,
  TokenCredential,
} from '@azure/identity';
import type {
  IAzureToken,
  ICreateTokenInput,
  ITokenResponse,
  IUser,
} from '../types';
import { TokenErrors, UserErrors } from './enum';
import { CustomError } from '../errorHandler';
import AzureToken from '../models/AzureToken';
import { remoteProcess } from './remote';
import User from '../models/User';
import logger from '../logger';

let client: ContainerRegistryManagementClient | null = null;

const createCredential = (): TokenCredential => {
  // Check if we're in production (has service principal credentials)
  if (
    process.env.AZURE_TENANT_ID != null &&
    process.env.AZURE_CLIENT_ID != null &&
    process.env.AZURE_CLIENT_SECRET != null
  ) {
    // Production: Use ClientSecretCredential
    return new ClientSecretCredential(
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      process.env.AZURE_CLIENT_SECRET,
      {
        // Optional configurations
        retryOptions: {
          maxRetries: 3,
          maxRetryDelayInMs: 5000,
        },
      }
    );
  }

  // Development: Use ChainedTokenCredential with AzureCliCredential first
  return new ChainedTokenCredential(
    new AzureCliCredential(),
    new DefaultAzureCredential({
      // Available options for better performance
      tenantId: process.env.AZURE_TENANT_ID,
      processTimeoutInMs: 5000, // 5 seconds timeout for CLI process
      retryOptions: {
        maxRetries: 3,
        maxRetryDelayInMs: 5000,
      },
    })
  );
};

type AzureError = Error & { statusCode?: number };
const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> => {
  let lastError: AzureError | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as AzureError | undefined;
      if (lastError?.statusCode === 409 && i < maxRetries - 1) {
        logger.info(
          `Retry ${i + 1}/${maxRetries} after ${baseDelay * Math.pow(2, i)}ms`
        );
        await delay(baseDelay * Math.pow(2, i));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('Max retries reached');
};

export const initializeAzureClient =
  async (): Promise<ContainerRegistryManagementClient> => {
    if (process.env.AZURE_SUBSCRIPTION_ID == null) {
      throw new Error('AZURE_SUBSCRIPTION_ID is required');
    }
    if (process.env.AZURE_TENANT_ID == null) {
      throw new Error('AZURE_TENANT_ID is required');
    }
    if (process.env.AZURE_CLIENT_ID == null) {
      throw new Error('AZURE_CLIENT_ID is required');
    }
    if (process.env.AZURE_CLIENT_SECRET == null) {
      throw new Error('AZURE_CLIENT_SECRET is required');
    }

    try {
      const credential = createCredential();

      client = new ContainerRegistryManagementClient(
        credential,
        process.env.AZURE_SUBSCRIPTION_ID
      );
      return client;
    } catch (error) {
      logger.error('Failed to create Azure client:', error);
      throw error;
    }
  };

export const getClient =
  async (): Promise<ContainerRegistryManagementClient | null> => {
    if (!client) {
      client = await initializeAzureClient();
    }
    return client;
  };

export const createToken = async (
  input: ICreateTokenInput
): Promise<ITokenResponse> => {
  const azureClient = await getClient();
  if (azureClient == null) {
    throw new CustomError('Azure client not initialized', 500);
  }

  const user = await User.findById(input.userId);
  if (!user) {
    throw new CustomError('User not found', 401);
  }

  const scopeMapName = input.scopeMapName ?? 'default-pull-access';

  return await retryOperation(async () => {
    const tokenResponse = await azureClient!.tokens.beginCreateAndWait(
      process.env.AZURE_RESOURCE_GROUP!,
      process.env.AZURE_ACR_NAME!,
      input.name,
      {
        status: 'enabled',
        scopeMapId: `/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${process.env.AZURE_RESOURCE_GROUP}/providers/Microsoft.ContainerRegistry/registries/${process.env.AZURE_ACR_NAME}/scopeMaps/${scopeMapName}`,
      }
    );

    // Generate credentials and wait for completion
    const credentialsPoller =
      await azureClient!.registries.beginGenerateCredentials(
        process.env.AZURE_RESOURCE_GROUP!,
        process.env.AZURE_ACR_NAME!,
        {
          name: 'password1',
          tokenId: tokenResponse.id!,
        }
      );

    const credentials = await credentialsPoller.pollUntilDone();

    const tokenValue = credentials.passwords?.[0]?.value;
    if (tokenValue == null) {
      throw new CustomError('Failed to generate token credentials', 500);
    }

    const tokenDoc = new AzureToken({
      ...input,
      token: tokenValue,
      lastUsedAt: new Date(),
    });

    await tokenDoc.save();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { token: _, ...tokenDocWithoutSecret } = tokenDoc.toObject();

    return {
      token: tokenValue,
      tokenDoc: tokenDocWithoutSecret,
    };
  });
};

export const validateToken = async (tokenString: string): Promise<string> => {
  const tokenDoc = await AzureToken.findOne({ token: tokenString })
    .populate('userId')
    .lean();

  if (!tokenDoc) {
    throw new CustomError(TokenErrors.INVALID_ACCESS_TOKEN, 401);
  }

  const user = tokenDoc.userId as unknown as IUser;
  if (user.subscription?.status !== 'active') {
    throw new CustomError(UserErrors.INVALID_SUBSCRIPTION, 401);
  }

  return user._id.toString();
};

export const validateRemoteToken = async (
  tokenString: string
): Promise<string> => {
  const userId = await remoteProcess<string, Record<string, string>>(
    '',
    'user/id',
    'GET',
    { 'x-access-token': tokenString }
  );
  if (userId != null && typeof userId === 'string') {
    return userId;
  }

  return await validateToken(tokenString);
};

export const listTokens = async (
  userId: string
): Promise<Omit<IAzureToken, 'token'>[]> => {
  return await AzureToken.find({ userId }).select('-token').lean();
};

export const deleteToken = async (
  userId: string,
  tokenName: string
): Promise<boolean> => {
  const azureClient = await getClient();
  if (!azureClient) {
    throw new CustomError('Azure client not initialized', 500);
  }
  const result = await AzureToken.deleteOne({
    userId,
    name: tokenName,
  });

  if (result.deletedCount === 1) {
    // Delete from Azure ACR
    await azureClient.tokens.beginDeleteAndWait(
      process.env.AZURE_RESOURCE_GROUP!,
      process.env.AZURE_ACR_NAME!,
      tokenName
    );
    return true;
  }
  return false;
};
