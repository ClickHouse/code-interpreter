import axios from 'axios';
import type { AxiosError } from 'axios';

export function applySystemReplacements(input: string): string {
  return input;
}

export function filterSystemLogs(stderr: string, isPyPlot?: boolean): string {
  const filteredStderr = applySystemReplacements(stderr);

  if (isPyPlot !== true) {
    return filteredStderr;
  }

  const lines = filteredStderr.split('\n');
  const logPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - (INFO|WARNING|ERROR|CRITICAL) - /;

  return lines.filter(line => !logPattern.test(line)).join('\n');
}

/**
 * Delays the execution for a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to delay.
 * @return {Promise<void>} A promise that resolves after the specified delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ErrorDetails {
  message: string;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  code?: string;
}

export function isValidId(id: string = ''): boolean {
  if (!id) {
    return false;
  }
  return /^[A-Za-z0-9_-]{21}$/.test(id);
}

export function getAxiosErrorDetails(error: unknown): ErrorDetails | unknown {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    return {
      message: axiosError.message,
      status: axiosError.response?.status,
      statusText: axiosError.response?.statusText,
      url: axiosError.config?.url,
      method: axiosError.config?.method?.toUpperCase(),
      code: axiosError.code
    };
  }
  return error;
}