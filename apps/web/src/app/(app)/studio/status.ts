export const STATUS = {
  QUEUED: ['na fila', 'warn'], PLANNING: ['escrevendo roteiro', 'warn'], GENERATING: ['gerando cenas', 'warn'], RENDERING: ['montando', 'warn'],
  READY: ['pronto', 'ok'], FAILED: ['falhou', 'err'], CANCELLED: ['cancelado', 'off'],
} as const;
