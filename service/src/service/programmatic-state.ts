import type * as t from '../types';
import type { LCTool } from '../preamble';
import type { ExecutionState } from './replay-state';

export interface BuildReplayExecutionStateParams {
  executionId: string;
  sessionId: string;
  sessionKey: string;
  userId: string;
  apiKeyId: string;
  authContext?: t.CodeApiAuthContext;
  code: string;
  tools: LCTool[];
  files?: t.RequestFile[];
  isPyPlot: boolean;
  timeout: number;
  language: 'python' | 'bash';
  now?: number;
}

export function buildReplayExecutionState(
  params: BuildReplayExecutionStateParams,
): ExecutionState {
  const now = params.now ?? Date.now();
  const authContext = params.authContext;
  return {
    execution_id: params.executionId,
    session_id: params.sessionId,
    sessionKey: params.sessionKey,
    userId: params.userId,
    tenantId: authContext?.tenantId ?? 'legacy',
    canonicalUserId: authContext?.userId ?? params.userId,
    orgId: authContext?.orgId,
    serviceId: authContext?.serviceId,
    chcUserId: authContext?.chcUserId,
    principalSource: authContext?.principalSource ?? 'librechat_jwt',
    authContextHash: authContext?.authContextHash,
    apiKeyId: params.apiKeyId,
    startTime: now,
    lastActivity: now,
    mode: 'replay',
    userCode: params.code,
    tools: params.tools,
    files: params.files,
    isPyPlot: params.isPyPlot,
    timeout: params.timeout,
    callCount: 0,
    language: params.language,
  };
}
