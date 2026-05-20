import type { Response } from 'express';
import type * as t from '../types';

export type CodeApiPrincipal = {
  userId: string;
  tenantId: string;
  role?: string;
  orgId?: string;
  serviceId?: string;
  chcUserId?: string;
  principalSource: 'librechat_jwt' | 'openid_reuse' | 'none' | string;
  authContextHash?: string;
  credentialId?: string;
  planId?: string;
};

export function applyPrincipal(req: t.AuthenticatedRequest, principal: CodeApiPrincipal): void {
  req.codeApiPrincipal = principal;
  if (principal.planId) {
    req.planId = principal.planId;
  }
  req.codeApiAuthContext = {
    userId: principal.userId,
    tenantId: principal.tenantId,
    orgId: principal.orgId,
    serviceId: principal.serviceId,
    chcUserId: principal.chcUserId,
    principalSource: principal.principalSource,
    authContextHash: principal.authContextHash,
  };
}

export function getPrincipal(req: t.AuthenticatedRequest): CodeApiPrincipal | undefined {
  if (req.codeApiPrincipal) {
    return req.codeApiPrincipal;
  }
  const ctx = req.codeApiAuthContext;
  if (!ctx?.userId) {
    return undefined;
  }
  return {
    userId: ctx.userId,
    tenantId: ctx.tenantId ?? 'legacy',
    orgId: ctx.orgId,
    serviceId: ctx.serviceId,
    chcUserId: ctx.chcUserId,
    principalSource: ctx.principalSource ?? 'librechat_jwt',
    authContextHash: ctx.authContextHash,
  };
}

export function getPrincipalOrReject(
  req: t.AuthenticatedRequest,
  res: Response,
): CodeApiPrincipal | undefined {
  const principal = getPrincipal(req);
  if (!principal?.userId) {
    res.status(401).json({ error: 'User not found' });
    return undefined;
  }
  return principal;
}

export function getCredentialId(req: t.AuthenticatedRequest): string {
  return getPrincipal(req)?.credentialId ?? '';
}
