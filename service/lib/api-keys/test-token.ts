import dotenv from 'dotenv';
import { initializeAzureClient, createToken, validateToken, listTokens } from './src/service/azureToken';
import mongoose from 'mongoose';
import User from './src/models/User';

dotenv.config();

async function testToken() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI!);
    console.log('Connected to MongoDB');

    // Create a test user or find existing one
    let testUser = await User.findOne({ 'subscription.status': 'active' });
    
    if (!testUser) {
      testUser = await User.create({
        email: 'test@example.com',
        subscription: {
          status: 'active',
          plan: 'basic'
        }
      });
      console.log('Created test user');
    } else {
      console.log('Found existing test user');
    }

    // Initialize Azure Client
    await initializeAzureClient();
    console.log('Azure client initialized');

    // Test creating a token
    const tokenInput = {
      userId: testUser._id.toString(),
      name: `test-token-${Date.now()}`,
      description: 'Test token'
    };

    console.log('Creating token...');
    const tokenResponse = await createToken(tokenInput);
    // Add this right after the token creation:
    console.log('Token details:');
    console.dir(tokenResponse, { depth: null });
    // Test validating the token
    console.log('\nValidating token...');
    const userId = await validateToken(tokenResponse.token);
    console.log('Token validated, userId:', userId);

    // Test listing tokens
    console.log('\nListing tokens...');
    const tokens = await listTokens(tokenInput.userId);
    console.log('Tokens:', tokens);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean up
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

// Run the test
testToken();