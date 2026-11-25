'use server';
import type { AITask } from '@social-manager/db';
import { run } from '@/lib/action';
import { int, oneOf, optStr, str } from '@/lib/form';
import { runAIJob } from '@/server/ai/jobs';

const TASKS: AITask[] = ['SCRIPT', 'SCRIPT_REVISION', 'CAPTION', 'IMAGE', 'NARRATION', 'VIDEO'];

export async function generateAction(fd: FormData) {
  await run('/ai/studio', async (ws) => {
    const task = oneOf(fd, 'task', TASKS, 'Tarefa');
    const id = await runAIJob({
      workspaceId: ws,
      task,
      prompt: str(fd, 'prompt'),
      clientId: optStr(fd, 'clientId'),
      requestedModelId: optStr(fd, 'modelId'),
      requestedBy: 'admin',
      params: {
        system: optStr(fd, 'system'),
        maxOutputTokens: int(fd, 'maxOutputTokens', 'Máx. de tokens de saída', 1, 32000),
        voice: optStr(fd, 'voice'),
        imageSize: optStr(fd, 'imageSize'),
      },
    });
    return { message: 'Geração concluída — veja o resultado abaixo.', to: `/ai/studio?job=${id}` };
  });
}
