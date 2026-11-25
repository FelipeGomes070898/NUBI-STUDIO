/** Erro com mensagem segura para mostrar ao usuário (validação, regra de negócio). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Qualquer outro erro vira mensagem genérica: nunca vazar detalhes internos ou segredos para a UI. */
export function userMessage(e: unknown): string {
  if (e instanceof UserError) return e.message;
  console.error('[unexpected]', e);
  return 'Erro inesperado. Verifique os logs do servidor.';
}
