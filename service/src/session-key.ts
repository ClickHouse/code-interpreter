import type { AuthenticatedRequest } from './types';

export function resolveSessionKey(req: AuthenticatedRequest, fallbackUserId: string, entityId?: string): string {
  const ctx = req.codeApiAuthContext;
  if (ctx?.tenantId && ctx.userId) {
    const base = `tenant:${ctx.tenantId}:user:${ctx.userId}`;
    return entityId ? `${base}:entity:${entityId}` : base;
  }

  return entityId ?? fallbackUserId;
}
