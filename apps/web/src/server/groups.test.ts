import { describe, expect, it } from 'vitest';
import { distinctFormats, resolveTargets, type GroupWithAccounts } from './groups';

const acc = (id: string, platform: 'FACEBOOK' | 'TIKTOK' | 'YOUTUBE', isActive = true) => ({ id, platform, displayName: id, isActive });
const luciano: GroupWithAccounts = {
  id: 'g1', name: 'Luciano ZEEN', defaultFormat: 'VERTICAL_9_16',
  accounts: [acc('fb1', 'FACEBOOK'), acc('fb2', 'FACEBOOK'), acc('fb3', 'FACEBOOK'), acc('tt', 'TIKTOK'), acc('yt', 'YOUTUBE')],
};
const espacial: GroupWithAccounts = { id: 'g2', name: 'Canal Espacial', defaultFormat: 'HORIZONTAL_16_9', accounts: [acc('yt2', 'YOUTUBE')] };

describe('resolveTargets', () => {
  it('grupo inteiro vira um destino por conta', () => {
    expect(resolveTargets([luciano]).map((t) => t.accountId)).toEqual(['fb1', 'fb2', 'fb3', 'tt', 'yt']);
  });
  it('permite desmarcar contas do grupo antes de agendar', () => {
    expect(resolveTargets([luciano], ['fb2', 'tt']).map((t) => t.accountId)).toEqual(['fb1', 'fb3', 'yt']);
  });
  it('conta em dois grupos selecionados vira um destino só', () => {
    const outro: GroupWithAccounts = { ...espacial, accounts: [acc('fb1', 'FACEBOOK'), acc('yt2', 'YOUTUBE')] };
    const t = resolveTargets([luciano, outro]);
    expect(t.filter((x) => x.accountId === 'fb1')).toHaveLength(1);
    expect(t.find((x) => x.accountId === 'fb1')!.viaGroups).toEqual(['Luciano ZEEN', 'Canal Espacial']);
  });
  it('ignora contas inativas e aceita contas avulsas', () => {
    const g = { ...espacial, accounts: [acc('a', 'YOUTUBE'), acc('b', 'YOUTUBE', false)] };
    const t = resolveTargets([g], [], [acc('solo', 'FACEBOOK'), acc('a', 'YOUTUBE')]);
    expect(t.map((x) => x.accountId)).toEqual(['a', 'solo']);
  });
});

describe('distinctFormats', () => {
  it('lista formatos concretos distintos (vertical + horizontal = duas versões)', () => {
    expect(distinctFormats([luciano, espacial, { defaultFormat: 'FLEXIBLE' }])).toEqual(['VERTICAL_9_16', 'HORIZONTAL_16_9']);
  });
});
