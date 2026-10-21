import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function recordAudit(actorId: string | null, action: string, targetType: string, targetId: string) {
  return prisma.auditEvent.create({ data: { actorId, action, targetType, targetId } });
}

// actorId holds a users.id; there is no relation, so the actor is loaded by hand.
export async function listAuditWithActor(limit = 50) {
  const events = await prisma.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((id): id is string => id !== null))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } } });
  const byId = new Map(actors.map((u) => [u.id, u]));
  return events.map((e) => ({ ...e, actor: e.actorId ? byId.get(e.actorId) ?? null : null }));
}
