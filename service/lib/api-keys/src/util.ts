import { isAxiosError } from 'axios';
import type { AxiosError } from 'axios';
import type { ErrorDetails } from './types';

export function getAxiosErrorDetails(error: unknown): ErrorDetails | unknown {
  if (isAxiosError(error) === true) {
    const axiosError = error as AxiosError;
    return {
      message: axiosError.message,
      status: axiosError.response?.status,
      statusText: axiosError.response?.statusText,
      url: axiosError.config?.url,
      method: axiosError.config?.method?.toUpperCase(),
      code: axiosError.code,
    };
  }
  return error;
}
