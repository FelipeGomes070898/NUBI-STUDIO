'use server';
import type { PublicationKind } from '@social-manager/db';
import { run } from '@/lib/action';
import { int, oneOf, str } from '@/lib/form';
import { setWeeklyGoal } from '@/server/publishing/goals';
import { UserError } from '@/server/errors';

export async function setGoalAction(fd: FormData) {
  await run('/goals', async (ws) => {
    const target = int(fd, 'target', 'Meta', 0, 50);
    if (target === undefined) throw new UserError('Informe a meta (0 desliga).');
    await setWeeklyGoal(ws, str(fd, 'accountId'), oneOf<PublicationKind>(fd, 'kind', ['POST', 'STORY'], 'Tipo'), target);
    return 'Meta atualizada.';
  });
}
