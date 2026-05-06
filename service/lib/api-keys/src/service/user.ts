import type { IUser, ServiceUser } from '../types';
import { remoteProcess } from './remote';
import { UserErrors } from './enum';
import User from '../models/User';

/**
 * Check subscription validity and reset usage in a single operation if needed
 * Returns the updated user and validity status
 */
export const checkSubscription = async (
  user: ServiceUser
): Promise<[ServiceUser, boolean]> => {
  if (!user.subscription) {
    return [user, false];
  }

  const now = new Date();
  const periodEnd = new Date(user.subscription.currentPeriodEnd ?? 0);
  const gracePeriod = new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000);

  const isValid = user.subscription.status === 'active' && now <= gracePeriod;

  return [user, isValid];
};

export const getUserById = async (userId: string): Promise<IUser | null> => {
  const user = await User.findById(userId).lean();

  if (!user) {
    return null;
  }

  return user;
};

export const getUserByStripeCustomerId = async (
  stripeCustomerId: string
): Promise<IUser | null> => {
  const user = await User.findOne({
    stripeCustomerId: stripeCustomerId,
  }).lean();

  if (!user) {
    return null;
  }

  return user;
};

export const getUserByTokenSub = async (
  tokenSub: string
): Promise<IUser | null> => {
  const user = await User.findById(tokenSub).lean();

  if (!user) {
    return null;
  }

  return user;
};

export const createUser = async (data: IUser): Promise<IUser> => {
  const user = new User(data);
  await user.save();

  return user;
};

export const validateUser = async (user: ServiceUser): Promise<ServiceUser> => {
  const [updatedUser, isValid] = await checkSubscription(user);

  if (!isValid) {
    throw new Error(UserErrors.INVALID_SUBSCRIPTION);
  }

  if (updatedUser.subscription?.currentPeriodEnd == null) {
    throw new Error(UserErrors.INVALID_SUBSCRIPTION);
  }

  const usageLimit = Number(updatedUser.subscription.metadata?.usageLimit) || 0;
  const cutoffDate = new Date('2025-02-01T00:00:00.000Z');
  const currentPeriodEnd = new Date(updatedUser.subscription.currentPeriodEnd);

  // Legacy usage check
  if (currentPeriodEnd < cutoffDate) {
    if ((updatedUser.usage ?? 0) >= usageLimit) {
      throw new Error(UserErrors.USAGE_LIMIT_EXCEEDED);
    }
    return updatedUser;
  }

  // Modern period-based usage check
  const periodKey = currentPeriodEnd.toISOString();
  const currentPeriodUsage = updatedUser.periodUsage?.[periodKey] ?? 0;

  if (currentPeriodUsage >= usageLimit) {
    throw new Error(UserErrors.USAGE_LIMIT_EXCEEDED);
  }

  return updatedUser;
};

export const validateAndGetUser = async (
  userId: string,
  apiKeyString?: string
): Promise<ServiceUser> => {
  const remoteUser = await remoteProcess<ServiceUser>(
    apiKeyString ?? '',
    'user',
    'GET'
  );
  if (remoteUser) {
    return remoteUser;
  }
  const user = await User.findOne(
    {
      _id: userId,
    },
    { subscription: 1, usage: 1, periodUsage: 1, enterprisePlans: 1 }
  ).lean();

  if (!user) {
    throw new Error(UserErrors.USER_NOT_FOUND);
  }

  if (user.subscription?.status !== 'active') {
    throw new Error(UserErrors.INVALID_SUBSCRIPTION);
  }

  return await validateUser(user);
};

export const incrementUserApiUsage = async (
  userId: string,
  apiKeyString?: string
): Promise<ServiceUser> => {
  const remoteUser = await remoteProcess<ServiceUser>(
    apiKeyString ?? '',
    'user/usage',
    'PATCH'
  );
  if (remoteUser) {
    return remoteUser;
  }
  const user = await User.findById(userId)
    .select('subscription usage periodUsage')
    .lean();

  if (!user) {
    throw new Error(UserErrors.USER_NOT_FOUND);
  }

  if (user.subscription?.currentPeriodEnd == null) {
    throw new Error(UserErrors.INVALID_SUBSCRIPTION);
  }

  const cutoffDate = new Date('2025-02-01T00:00:00.000Z');
  const currentPeriodEnd = new Date(user.subscription.currentPeriodEnd);

  // Legacy usage handling
  if (currentPeriodEnd < cutoffDate) {
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $inc: { usage: 1 } },
      {
        new: true,
        select: {
          usage: 1,
          periodUsage: 1,
          subscription: 1,
          enterprisePlans: 1,
        },
      }
    ).lean();
    if (!updatedUser) {
      throw new Error(UserErrors.USER_NOT_FOUND);
    }
    return updatedUser;
  }

  // Modern period-based usage handling
  const periodKey = currentPeriodEnd.toISOString();
  const currentPeriodUsage = user.periodUsage?.[periodKey] ?? 0;

  const updateResult = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        periodUsage: {
          ...user.periodUsage,
          [periodKey]: currentPeriodUsage + 1,
        },
      },
    },
    {
      new: true,
      select: { subscription: 1, periodUsage: 1, usage: 1, enterprisePlans: 1 },
    }
  ).lean();

  if (!updateResult) {
    throw new Error(UserErrors.USER_NOT_FOUND);
  }

  return updateResult;
};

export const updateUser = async (
  userId: string,
  data: Partial<IUser>
): Promise<IUser> => {
  const user = await User.findByIdAndUpdate(userId, data, { new: true }).lean();

  if (!user) {
    throw new Error(UserErrors.USER_NOT_FOUND);
  }

  return user;
};

export const deleteUser = async (userId: string): Promise<ServiceUser> => {
  const user = await User.findByIdAndDelete(userId).lean();

  if (!user) {
    throw new Error(UserErrors.USER_NOT_FOUND);
  }

  return user;
};
