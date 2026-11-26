import { describe, expect, it } from 'vitest';
import { assertSchedulable, describeConflicts, findSlotConflicts } from './schedule';

const at = (s: string) => new Date(`2026-11-26T${s}:00Z`);

describe('findSlotConflicts', () => {
  const taken = [at('12:00'), at('15:30')];
  it('acha horários a menos do intervalo, antes ou depois', () => {
    expect(findSlotConflicts(taken, at('12:30'), 60)).toEqual([at('12:00')]);
    expect(findSlotConflicts(taken, at('11:30'), 60)).toEqual([at('12:00')]);
    expect(findSlotConflicts(taken, at('15:00'), 60)).toEqual([at('15:30')]);
  });
  it('no limite exato do intervalo já está livre', () => {
    expect(findSlotConflicts(taken, at('13:00'), 60)).toEqual([]);
    expect(findSlotConflicts(taken, at('11:00'), 60)).toEqual([]);
  });
  it('mesmo horário sempre conflita; intervalo 0 só bloqueia o minuto idêntico', () => {
    expect(findSlotConflicts(taken, at('12:00'), 60)).toEqual([at('12:00')]);
    expect(findSlotConflicts(taken, at('12:00'), 0)).toEqual([at('12:00')]);
    expect(findSlotConflicts(taken, at('12:01'), 0)).toEqual([]);
  });
});

describe('assertSchedulable', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  it('exige futuro com folga e limite de 1 ano', () => {
    expect(() => assertSchedulable(new Date('2026-11-26T11:59:00Z'), now)).toThrow(/futuro/);
    expect(() => assertSchedulable(new Date('2026-11-26T12:00:30Z'), now)).toThrow(/1 minuto/);
    expect(() => assertSchedulable(new Date('2026-11-26T12:02:00Z'), now)).not.toThrow();
    expect(() => assertSchedulable(new Date('2028-01-01T00:00:00Z'), now)).toThrow(/dias à frente/);
    expect(() => assertSchedulable(new Date('x'), now)).toThrow(/inválidas/);
  });
});

describe('describeConflicts', () => {
  it('lista cada conta em conflito com o horário no fuso do usuário e ignora as livres', () => {
    const msg = describeConflicts(
      [
        { accountName: 'Luciano TikTok', platform: 'TIKTOK', taken: [at('12:00')] },
        { accountName: 'Luciano YouTube', platform: 'YOUTUBE', taken: [at('20:00')] },
      ],
      at('12:20'), 60, 'America/Sao_Paulo',
    );
    expect(msg).toContain('Luciano TikTok (TIKTOK) já tem publicação em 26/11/2026, 09:00');
    expect(msg).not.toContain('YouTube');
    expect(msg).toContain('intervalo mínimo de 60 min');
    expect(describeConflicts([{ accountName: 'x', platform: 'P', taken: [at('20:00')] }], at('12:00'), 60, 'UTC')).toBeNull();
  });
});
