import { PrismaClient, EnrollmentStatus } from '@prisma/client';
import { recordAudit } from './audit-service';

const prisma = new PrismaClient();

export async function enroll(userId: string, courseId: string) {
  const enrollment = await prisma.enrollment.create({ data: { userId, courseId } });
  await recordAudit(userId, 'enroll', 'course', courseId);
  return enrollment;
}

export async function completeLesson(userId: string, courseId: string, lessonId: string) {
  return prisma.lessonProgress.upsert({
    where: { userId_lessonId: { userId, lessonId } },
    create: { userId, courseId, lessonId, completedAt: new Date() },
    update: { completedAt: new Date() },
  });
}

export async function refund(userId: string, courseId: string) {
  await prisma.enrollment.update({
    where: { userId_courseId: { userId, courseId } },
    data: { status: EnrollmentStatus.REFUNDED },
  });
  await recordAudit(userId, 'refund', 'course', courseId);
}
