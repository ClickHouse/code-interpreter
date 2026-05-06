import axios, { AxiosRequestConfig, Method } from 'axios';
import mongoose from 'mongoose';
import { getAxiosErrorDetails } from '../util';
import logger from '../logger';

const remoteURL =
  process.env.TEST_REMOTE_URL ?? 'https://api.librechat.ai/v1/enterprise/';

function buildURL(baseURL: string, path: string): string {
  const cleanBase = baseURL.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');

  return `${cleanBase}/${cleanPath}`;
}

export async function remoteProcess<TReturn, TPayload = undefined>(
  apiKeyString: string,
  path: string,
  method: Method = 'GET',
  payload?: TPayload
): Promise<TReturn | void> {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve();
  }

  const endpoint = buildURL(remoteURL, path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const config: AxiosRequestConfig = {
    method,
    url: endpoint,
  };

  if (apiKeyString) {
    headers['x-api-key'] = apiKeyString;
  }

  config.headers = headers;

  if (payload != null && method !== 'GET') {
    config.data = payload;
  } else if (payload != null) {
    config.headers = Object.assign({}, config.headers, payload);
  }

  try {
    if (process.env.DEBUG_REMOTE_PROCESS === 'true') {
      logger.info(
        `Making ${method} request to ${endpoint} with ${apiKeyString}`
      );
    }
    const response = await axios<TReturn>(config);
    return response.data;
  } catch (error) {
    throw getAxiosErrorDetails(error);
  }
}

/**
// Usage examples:
// GET request
const data = await remoteProcess<UserData>('apiKey', 'user/profile');

// POST request with payload
const result = await remoteProcess<ResponseType, PayloadType>(
  'apiKey',
  'user/usage',
  'POST',
  { count: 1 }
);
 */
