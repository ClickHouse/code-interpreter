import { z } from 'zod';
import { CustomError } from './errorHandler';
import { Types } from 'mongoose';

const objectIdSchema = z.custom<Types.ObjectId>(
  (val) => val instanceof Types.ObjectId || Types.ObjectId.isValid(val),
  {
    message: 'Invalid ObjectId',
  }
);

const schemas = {
  createApiKey: z.object({
    userId: objectIdSchema,
    name: z.string().min(1),
    limit: z.number().int().min(0).optional(),
    isEnterprise: z.boolean().optional(),
    expiration: z
      .union([z.string(), z.date()])
      .optional()
      .transform((val) => {
        if (val instanceof Date) {
          return val.toISOString();
        }
        return val;
      }),
  }),
  validateApiKey: z.object({
    apiKeyString: z.string(),
  }),
  incrementApiKeyUsage: z.object({
    apiKeyId: objectIdSchema,
  }),
  deleteApiKey: z.object({
    apiKeyId: objectIdSchema,
    userId: objectIdSchema,
  }),
  listApiKeys: z.object({
    userId: objectIdSchema,
  }),
  getApiKeyDetails: z.object({
    apiKeyId: objectIdSchema,
    userId: objectIdSchema,
  }),
  updateApiKey: z.object({
    apiKeyId: objectIdSchema,
    userId: objectIdSchema,
    updates: z.object({
      name: z.string().min(1).optional(),
      limit: z.number().int().min(0).nullable().optional(),
      expiration: z
        .union([z.string(), z.date(), z.null()])
        .optional()
        .transform((val) => {
          if (val instanceof Date) {
            return val.toISOString();
          }
          return val;
        }),
    }),
  }),
  resetApiKeyUsage: z.object({
    apiKeyId: objectIdSchema,
    userId: objectIdSchema,
  }),
  checkUserApiKeyLimit: z.object({
    userId: objectIdSchema,
    maxKeys: z.number().int().positive(),
  }),
  deleteApiKeysForUser: z.object({
    userId: objectIdSchema,
  }),
};

type SchemaKey = keyof typeof schemas;

export const validateInput = <T extends SchemaKey>(
  input: unknown,
  schemaName: T
): z.infer<(typeof schemas)[T]> => {
  const schema = schemas[schemaName] as (typeof schemas)[T] | undefined;
  if (!schema) {
    throw new Error(`Schema not found: ${schemaName}`);
  }

  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const zodError = error as z.ZodError;
      throw new CustomError(`${zodError.errors[0].message}`, 400);
    }
    throw error;
  }
};
