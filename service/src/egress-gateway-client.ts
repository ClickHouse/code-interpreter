import axios from 'axios';
import { env } from './config';
import type { ExecutionManifestClaims } from './execution-manifest';
import { internalServiceHeaders } from './internal-service-auth';
import type * as t from './types';

type GatewayRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface GatewayPreparedEgress {
  grant_id: string;
  payload: t.PayloadBody;
  egressGrantToken: string;
  executionManifestClaims: ExecutionManifestClaims;
}

function gatewayUrl(path: string): string {
  if (!env.EGRESS_GATEWAY_URL.trim()) {
    throw new Error('EGRESS_GATEWAY_URL is required for hardened sandbox egress');
  }
  return `${env.EGRESS_GATEWAY_URL.replace(/\/+$/, '')}${path}`;
}

export async function createGatewayEgressGrant(args: {
  payload: t.PayloadBody;
  claims: ExecutionManifestClaims;
  signal?: AbortSignal;
}): Promise<GatewayPreparedEgress> {
  const { signal, ...body } = args;
  const response = await axios.post<GatewayPreparedEgress>(
    gatewayUrl('/internal/egress-grants'),
    body,
    {
      headers: internalServiceHeaders({ 'Content-Type': 'application/json' }),
      signal,
      timeout: env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  );
  return response.data;
}

export async function restoreGatewaySandboxResult<T extends { session_id: string; files?: t.FileRefs }>(args: {
  grantId?: string;
  egressGrantToken: string;
  result: T;
  signal?: AbortSignal;
}): Promise<T> {
  const path = args.grantId
    ? `/internal/egress-grants/${encodeURIComponent(args.grantId)}/restore-result`
    : '/internal/egress-grants/restore-result';
  const response = await axios.post<{ result: T }>(
    gatewayUrl(path),
    { result: args.result, egressGrantToken: args.egressGrantToken },
    {
      headers: internalServiceHeaders({ 'Content-Type': 'application/json' }),
      signal: args.signal,
      timeout: env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  );
  return response.data.result;
}

export async function revokeGatewayEgressGrant(args: {
  grantId?: string;
  egressGrantToken?: string;
  reason: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!args.grantId && !args.egressGrantToken) {
    throw new Error('grantId or egressGrantToken is required to revoke egress grant');
  }
  const path = args.grantId
    ? `/internal/egress-grants/${encodeURIComponent(args.grantId)}/revoke`
    : '/internal/egress-grants/revoke';
  const body = args.grantId
    ? { reason: args.reason }
    : { reason: args.reason, egressGrantToken: args.egressGrantToken };
  await axios.post(
    gatewayUrl(path),
    body,
    {
      headers: internalServiceHeaders({ 'Content-Type': 'application/json' }),
      timeout: args.timeoutMs ?? env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
    },
  );
}

export async function createGatewayPtcCallbackToken(args: {
  executionId: string;
  sessionId: string;
  callbackToken: string;
  timeoutSeconds: number;
  allowedToolNames: string[];
}, options: GatewayRequestOptions = {}): Promise<string> {
  const response = await axios.post<{ callbackToken: string }>(
    gatewayUrl('/internal/ptc-callback-token'),
    args,
    {
      headers: internalServiceHeaders({ 'Content-Type': 'application/json' }),
      signal: options.signal,
      timeout: options.timeoutMs ?? env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  );
  return response.data.callbackToken;
}
