// jest.setup.ts
const { config } = require('dotenv');

// Load test environment variables
config();

// Verify required environment variables
const requiredEnvVars = [
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_RESOURCE_GROUP',
  'AZURE_ACR_NAME',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
];

const missingVars = requiredEnvVars.filter(
  (varName) => !process.env[varName]
);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(', ')}\n` +
    'Please check your environment configuration.'
  );
}