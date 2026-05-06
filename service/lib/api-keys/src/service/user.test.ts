import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUser, ISubscription } from '@/types';
import {
  getUserByStripeCustomerId,
  incrementUserApiUsage,
  validateAndGetUser,
  checkSubscription,
  getUserByTokenSub,
  getUserById,
  deleteUser,
  updateUser,
  createUser,
} from './user';
import { UserErrors } from './enum';
import User from '@/models/User';

let mongoServer: MongoMemoryServer;

const connectDB = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 1) {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  }
};

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }

  await mongoServer.stop();
});

const createTestUser = async (
  overrides: Partial<IUser> = {}
): Promise<IUser> => {
  const now = new Date();
  const defaultUser = {
    name: 'Test User',
    email: `test${Date.now()}@example.com`,
    usage: 0,
    subscription: {
      id: 'sub_123',
      status: 'active',
      planId: 'plan_123',
      priceId: 'price_123',
      currentPeriodEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      metadata: {
        usageLimit: '100',
      },
    },
  };

  const user = await User.create({
    ...defaultUser,
    ...overrides,
    subscription: {
      ...defaultUser.subscription,
      ...(overrides.subscription || {}),
    },
  });

  return user.toObject();
};

const createLegacyTestUser = async (
  overrides: Partial<IUser> = {}
): Promise<IUser> => {
  const legacyDate = new Date('2025-01-31T00:00:00.000Z'); // Date before February 2025

  return createTestUser({
    usage: 0,
    subscription: {
      id: 'sub_123',
      status: 'active',
      planId: 'plan_123',
      priceId: 'price_123',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: legacyDate,
      metadata: {
        usageLimit: '100',
      },
    },
    ...overrides,
  });
};

const createModernTestUser = async (
  overrides: Partial<IUser> = {}
): Promise<IUser> => {
  const futureDate = new Date('2025-03-15T00:00:00.000Z');

  // Create base user
  const user = await createTestUser({
    periodUsage: {},
    subscription: {
      id: 'sub_123',
      status: 'active',
      planId: 'plan_123',
      priceId: 'price_123',
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: false,
      metadata: {
        usageLimit: '100',
      },
    },
    ...overrides,
  });

  // If periodUsage is provided, update it in a separate operation
  if (overrides.periodUsage) {
    await User.findByIdAndUpdate(user._id, {
      $set: { periodUsage: overrides.periodUsage },
    });
    return (await User.findById(user._id).lean())!;
  }

  return user;
};

describe('User Service', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }

    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
  });

  describe('checkSubscription', () => {
    it('should return valid status for active subscription', async () => {
      const user = await createTestUser();
      const [updatedUser, isValid] = await checkSubscription(user);

      expect(isValid).toBe(true);
      expect(updatedUser.usage).toBe(0);
    });

    it('should handle both Date objects and date strings for currentPeriodEnd', async () => {
      // Test with Date object
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const userWithDateObject = await createTestUser({
        email: 'test1@example.com', // unique email
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: tomorrow,
          cancelAtPeriodEnd: false,
        },
      });
      const isValid1 = (await checkSubscription(userWithDateObject))[1];
      expect(isValid1).toBe(true);

      // Test with date string
      const tomorrowString = tomorrow.toISOString();
      const userWithDateString = await createTestUser({
        email: 'test2@example.com', // unique email
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: tomorrowString,
          cancelAtPeriodEnd: false,
        },
      });
      const [updatedUser2, isValid2] =
        await checkSubscription(userWithDateString);
      expect(isValid2).toBe(true);

      // Test with past date string
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayString = yesterday.toISOString();
      const userWithPastDateString = await createTestUser({
        email: 'test3@example.com', // unique email
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: yesterdayString,
          cancelAtPeriodEnd: false,
        },
      });
      const isValid3 = (await checkSubscription(userWithPastDateString))[1];
      expect(isValid3).toBe(false);

      const subscription1 = userWithDateObject.subscription;
      expect(subscription1).toBeDefined();

      // Verify both types give consistent results
      expect(isValid1).toBe(isValid2);
      expect(subscription1?.currentPeriodEnd instanceof Date).toBe(
        updatedUser2.subscription?.currentPeriodEnd instanceof Date
      );
    });

    it('should return valid status for active subscription with cancelAtPeriodEnd true within period', async () => {
      const now = new Date();
      const user = await createTestUser({
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 1 day in future
          cancelAtPeriodEnd: true,
          metadata: {
            usageLimit: '100',
          },
        },
      });

      const [updatedUser, isValid] = await checkSubscription(user);

      expect(isValid).toBe(true);
      expect(updatedUser.subscription?.cancelAtPeriodEnd).toBe(true);
    });

    it('should return invalid status for active subscription with cancelAtPeriodEnd true after period end', async () => {
      const now = new Date();
      const user = await createTestUser({
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: new Date(now.getTime() - 48 * 60 * 60 * 1000), // 2 days in past
          cancelAtPeriodEnd: true,
          metadata: {
            usageLimit: '100',
          },
        },
      });

      const [updatedUser, isValid] = await checkSubscription(user);

      expect(isValid).toBe(false);
      expect(updatedUser.subscription?.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('validateAndGetUser', () => {
    it('should validate active user successfully', async () => {
      const user = await createTestUser();
      const validatedUser = await validateAndGetUser(user._id);

      expect(validatedUser).toBeDefined();
      expect(validatedUser.subscription?.status).toBe('active');
    });

    it('should throw error for inactive subscription', async () => {
      const user = await createTestUser({
        subscription: {
          id: 'sub_123',
          status: 'canceled',
          planId: 'plan_123',
          priceId: 'price_123',
          currentPeriodEnd: new Date(),
          cancelAtPeriodEnd: true,
        },
      });

      await expect(validateAndGetUser(user._id)).rejects.toThrow(
        UserErrors.INVALID_SUBSCRIPTION
      );
    });

    it('should throw error when usage limit exceeded', async () => {
      const user = await createTestUser({
        usage: 150,
      });

      await expect(validateAndGetUser(user._id)).rejects.toThrow(
        UserErrors.USAGE_LIMIT_EXCEEDED
      );
    });
  });

  describe('incrementUserApiUsage', () => {
    it('should increment usage by 1', async () => {
      const user = await createTestUser({ usage: 5 });
      const updatedUser = await incrementUserApiUsage(user._id);

      expect(updatedUser.usage).toBe(6);
    });

    it('should throw error for non-existent user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(incrementUserApiUsage(fakeId.toString())).rejects.toThrow(
        UserErrors.USER_NOT_FOUND
      );
    });
  });
});

describe('Usage tracking', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }

    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
  });

  describe('validateUser', () => {
    it('should validate legacy usage successfully', async () => {
      const user = await createLegacyTestUser({ usage: 50 });
      const validatedUser = await validateAndGetUser(user._id);

      expect(validatedUser).toBeDefined();
      expect(validatedUser.usage).toBe(50);
    });

    it('should validate period-based usage successfully', async () => {
      const futureDate = new Date('2025-03-15T00:00:00.000Z');
      const periodKey = futureDate.toISOString();
      const user = await createModernTestUser({
        periodUsage: { [periodKey]: 50 },
      });

      const validatedUser = await validateAndGetUser(user._id);

      expect(validatedUser).toBeDefined();
      expect(validatedUser.periodUsage?.[periodKey]).toBe(50);
    });

    it('should throw error when legacy usage limit exceeded', async () => {
      const user = await createLegacyTestUser({ usage: 150 });
      await expect(validateAndGetUser(user._id)).rejects.toThrow(
        UserErrors.USAGE_LIMIT_EXCEEDED
      );
    });

    it('should throw error when period usage limit exceeded', async () => {
      const futureDate = new Date('2025-03-15T00:00:00.000Z');
      const periodKey = futureDate.toISOString();
      const user = await createModernTestUser({
        periodUsage: { [periodKey]: 150 },
      });

      await expect(validateAndGetUser(user._id)).rejects.toThrow(
        UserErrors.USAGE_LIMIT_EXCEEDED
      );
    });
  });

  describe('incrementUserApiUsage', () => {
    it('should increment legacy usage by 1', async () => {
      const user = await createLegacyTestUser({ usage: 5 });
      const updatedUser = await incrementUserApiUsage(user._id);

      expect(updatedUser.usage).toBe(6);
    });

    it('should increment period usage by 1', async () => {
      const futureDate = new Date('2025-03-15T00:00:00.000Z');
      const periodKey = futureDate.toISOString();
      const user = await createModernTestUser({
        periodUsage: { [periodKey]: 5 },
      });

      const updatedUser = await incrementUserApiUsage(user._id);

      expect(updatedUser.periodUsage?.[periodKey]).toBe(6);
    });

    it('should initialize period usage if not exists', async () => {
      const futureDate = new Date('2025-03-15T00:00:00.000Z');
      const periodKey = futureDate.toISOString();
      const user = await createModernTestUser({
        periodUsage: undefined,
      });

      const updatedUser = await incrementUserApiUsage(user._id);

      expect(updatedUser.periodUsage?.[periodKey]).toBe(1);
    });

    it('should handle transition period correctly', async () => {
      // Create user with subscription period ending exactly at cutoff
      const cutoffDate = new Date('2025-02-01T00:00:00.000Z');
      const user = await createTestUser({
        usage: 5,
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: cutoffDate,
          metadata: {
            usageLimit: '100',
          },
        },
      });

      // Verify initial state
      expect(user.usage).toBe(5);

      // Increment usage during legacy period
      const updatedUser = await User.findByIdAndUpdate(
        user._id,
        { $inc: { usage: 1 } },
        { new: true }
      ).lean();

      // Should still use legacy usage
      expect(updatedUser?.usage).toBe(6);

      // Update subscription to period after cutoff
      const futureDate = new Date('2025-03-15T00:00:00.000Z');
      await updateUser(user._id, {
        subscription: {
          id: 'sub_123',
          status: 'active',
          planId: 'plan_123',
          priceId: 'price_123',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: futureDate,
          metadata: {
            usageLimit: '100',
          },
        },
      });

      // Should now use period-based usage
      const finalUser = await incrementUserApiUsage(user._id);
      const periodKey = futureDate.toISOString();
      expect(finalUser.periodUsage?.[periodKey]).toBe(1);
    });
  });
});

describe('getUserById', () => {
  beforeEach(async () => {
    await connectDB();
  });

  it('should return the user if found', async () => {
    const user = await createTestUser();
    const foundUser = await getUserById(user._id);

    expect(foundUser).toBeDefined();
    expect(foundUser?._id.toString()).toBe(user._id.toString());
  });

  it('should return null if user is not found', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const result = await getUserById(fakeId);
    expect(result).toBeNull();
  });
});

describe('getUserByStripeCustomerId', () => {
  beforeEach(async () => {
    await connectDB();
  });

  it('should return user when found by stripeCustomerId', async () => {
    const stripeCustomerId = 'cus_123456';
    const user = await createTestUser({ stripeCustomerId });

    const foundUser = await getUserByStripeCustomerId(stripeCustomerId);

    expect(foundUser).toBeDefined();
    expect(foundUser?.stripeCustomerId).toBe(stripeCustomerId);
    expect(foundUser?._id.toString()).toBe(user._id.toString());
  });

  it('should return null when user not found', async () => {
    const nonExistentStripeId = 'cus_nonexistent';
    const result = await getUserByStripeCustomerId(nonExistentStripeId);
    expect(result).toBeNull();
  });

  it('should return user with all expected fields', async () => {
    const stripeCustomerId = 'cus_789012';
    const userData = {
      stripeCustomerId,
      name: 'Stripe User',
      email: 'stripe@example.com',
      usage: 5,
    };

    await createTestUser(userData);
    const foundUser = await getUserByStripeCustomerId(stripeCustomerId);

    expect(foundUser).not.toBeNull();
    if (foundUser) {
      expect(foundUser).toMatchObject(userData);
      expect(foundUser.subscription).toBeDefined();
    }
  });
});

describe('getUserByTokenSub', () => {
  beforeEach(async () => {
    await connectDB();
  });

  it('should return the user when found by token sub', async () => {
    const user = await createTestUser();
    const foundUser = await getUserByTokenSub(user._id);

    expect(foundUser).toBeDefined();
    expect(foundUser?._id.toString()).toBe(user._id.toString());
  });

  it('should return null when user not found', async () => {
    const fakeTokenSub = new mongoose.Types.ObjectId().toString();
    const result = await getUserByTokenSub(fakeTokenSub);
    expect(result).toBeNull();
  });

  it('should return user with all expected fields', async () => {
    const userData = {
      name: 'Token User',
      email: 'token@example.com',
      usage: 5,
      subscription: {
        id: 'sub_test',
        status: 'active' as ISubscription['status'],
        planId: 'plan_test',
        priceId: 'price_test',
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        metadata: {
          usageLimit: '100',
        },
      },
    };

    const user = await createTestUser(userData);
    const foundUser = await getUserByTokenSub(user._id);

    expect(foundUser).not.toBeNull();
    if (foundUser) {
      expect(foundUser).toMatchObject(userData);
      expect(foundUser.subscription).toBeDefined();
    }
  });
});

describe('createUser', () => {
  beforeEach(async () => {
    await connectDB();
  });

  it('should create a new user successfully', async () => {
    const userData = {
      name: 'New Test User',
      email: 'newtest@example.com',
      usage: 0,
      subscription: {
        id: 'sub_test',
        status: 'active' as ISubscription['status'],
        planId: 'plan_test',
        priceId: 'price_test',
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        metadata: {
          usageLimit: '100',
        },
      },
    };

    const createdUser = await createUser(userData as unknown as IUser);

    expect(createdUser).toBeDefined();
    expect(createdUser.name).toBe(userData.name);
    expect(createdUser.email).toBe(userData.email);
    expect(createdUser.usage).toBe(userData.usage);
    expect(createdUser.subscription).toMatchObject(userData.subscription);
  });

  it('should create a user with minimal required fields', async () => {
    const minimalUserData = {
      name: 'Minimal User',
      email: 'minimal@example.com',
    };

    const createdUser = await createUser(minimalUserData as IUser);

    expect(createdUser).toBeDefined();
    expect(createdUser.name).toBe(minimalUserData.name);
    expect(createdUser.email).toBe(minimalUserData.email);
    expect(createdUser.usage ?? 0).toBe(0); // Changed this line
    expect(createdUser.periodUsage).toEqual({});
  });

  it('should persist the user in the database', async () => {
    const userData = {
      name: 'Persistent User',
      email: 'persistent@example.com',
      usage: 0,
    };

    const createdUser = await createUser(userData as IUser);
    const foundUser = await User.findById(createdUser._id).lean();

    expect(foundUser).toBeDefined();
    expect(foundUser?.name).toBe(userData.name);
    expect(foundUser?.email).toBe(userData.email);
  });
});

describe('deleteUser', () => {
  beforeEach(async () => {
    await connectDB();
  });

  it('should delete the user if found', async () => {
    const user = await createTestUser();
    const deletedUser = await deleteUser(user._id);

    expect(deletedUser).toBeDefined();
    expect(deletedUser._id.toString()).toBe(user._id.toString());

    const foundUser = await User.findById(user._id);
    expect(foundUser).toBeNull();
  });

  it('should throw an error if user is not found', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();

    await expect(deleteUser(fakeId)).rejects.toThrow(UserErrors.USER_NOT_FOUND);
  });

  describe('updateUser', () => {
    beforeEach(async () => {
      await connectDB();
    });

    it('should update user fields successfully', async () => {
      // Create test user
      const user = await createTestUser();

      // Update data
      const updateData = {
        name: 'Updated Name',
        email: 'updated@example.com',
        usage: 10,
      };

      const updatedUser = await updateUser(user._id, updateData);

      expect(updatedUser).toBeDefined();
      expect(updatedUser.name).toBe(updateData.name);
      expect(updatedUser.email).toBe(updateData.email);
      expect(updatedUser.usage).toBe(updateData.usage);
    });

    it('should update subscription fields successfully', async () => {
      const user = await createTestUser();

      const newSubscription = {
        id: 'sub_456',
        status: 'active' as ISubscription['status'],
        planId: 'plan_456',
        priceId: 'price_456',
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: true,
        metadata: {
          usageLimit: '200',
        },
      } as ISubscription;

      const updatedUser = await updateUser(user._id, {
        subscription: newSubscription,
      });

      expect(updatedUser.subscription).toMatchObject(newSubscription);
    });

    it('should throw error when user not found', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const updateData = { name: 'New Name' };

      await expect(updateUser(fakeId, updateData)).rejects.toThrow(
        UserErrors.USER_NOT_FOUND
      );
    });

    it('should return updated document with new values', async () => {
      const user = await createTestUser();
      const beforeUpdate = await User.findById(user._id).lean();

      const updateData = { usage: 42 };
      const updatedUser = await updateUser(user._id, updateData);

      expect(updatedUser.usage).toBe(42);
      expect(updatedUser.usage).not.toBe(beforeUpdate?.usage);
    });
  });
});
