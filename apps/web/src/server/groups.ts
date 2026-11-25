import type { SocialPlatform, VideoFormat } from '@social-manager/db';

export interface GroupWithAccounts {
  id: string;
  name: string;
  defaultFormat: VideoFormat;
  accounts: Array<{ id: string; platform: SocialPlatform; displayName: string; isActive: boolean }>;
}

export interface ResolvedTarget {
  accountId: string;
  platform: SocialPlatform;
  displayName: string;
  /** Grupos selecionados pelos quais a conta entrou (uma conta só vira um destino). */
  viaGroups: string[];
}

/**
 * Expande grupos selecionados em destinos de publicação.
 *  - O grupo é organização, não obrigação: `excludedAccountIds` remove contas antes de agendar.
 *  - Conta presente em vários grupos selecionados vira UM destino (evita post duplicado).
 *  - Contas inativas são ignoradas.
 *  - `extraAccounts` permite contas individuais fora de qualquer grupo.
 * Base da etapa de Publicações; não depende de banco.
 */
export function resolveTargets(
  groups: GroupWithAccounts[],
  excludedAccountIds: string[] = [],
  extraAccounts: GroupWithAccounts['accounts'] = [],
): ResolvedTarget[] {
  const excluded = new Set(excludedAccountIds);
  const byAccount = new Map<string, ResolvedTarget>();

  const add = (a: GroupWithAccounts['accounts'][number], via?: string) => {
    if (!a.isActive || excluded.has(a.id)) return;
    const existing = byAccount.get(a.id);
    if (existing) {
      if (via && !existing.viaGroups.includes(via)) existing.viaGroups.push(via);
      return;
    }
    byAccount.set(a.id, { accountId: a.id, platform: a.platform, displayName: a.displayName, viaGroups: via ? [via] : [] });
  };

  for (const g of groups) for (const a of g.accounts) add(a, g.name);
  for (const a of extraAccounts) add(a);
  return [...byAccount.values()];
}

/** Formatos distintos entre grupos selecionados: o vídeo precisa de uma versão por formato. */
export function distinctFormats(groups: Pick<GroupWithAccounts, 'defaultFormat'>[]): VideoFormat[] {
  return [...new Set(groups.map((g) => g.defaultFormat).filter((f) => f !== 'FLEXIBLE'))];
}
