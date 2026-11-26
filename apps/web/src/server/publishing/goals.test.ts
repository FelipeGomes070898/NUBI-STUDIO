import { describe, expect, it } from 'vitest';
import { goalStatus, kindsFor, weekRange } from './goals';

describe('weekRange (domingo a domingo, como o Plano da Meta)', () => {
  it('quarta-feira no Brasil: semana começa no domingo 00:00 local e termina no próximo domingo', () => {
    const r = weekRange(new Date('2026-11-25T15:00:00Z'), 'America/Sao_Paulo'); // quarta
    expect(r.start.toISOString()).toBe('2026-11-22T03:00:00.000Z'); // domingo 22/11 00:00 (UTC-3)
    expect(r.end.toISOString()).toBe('2026-11-29T03:00:00.000Z');
  });
  it('no próprio domingo continua na mesma semana; no sábado à noite ainda é a semana que acaba', () => {
    expect(weekRange(new Date('2026-11-22T03:00:00Z'), 'America/Sao_Paulo').start.toISOString()).toBe('2026-11-22T03:00:00.000Z');
    expect(weekRange(new Date('2026-11-29T02:59:00Z'), 'America/Sao_Paulo').start.toISOString()).toBe('2026-11-22T03:00:00.000Z');
    expect(weekRange(new Date('2026-11-29T03:00:00Z'), 'America/Sao_Paulo').start.toISOString()).toBe('2026-11-29T03:00:00.000Z');
  });
  it('usa o dia LOCAL, não o UTC (sábado 23h em Brasília já é domingo em UTC)', () => {
    const r = weekRange(new Date('2026-11-29T01:30:00Z'), 'America/Sao_Paulo'); // sáb 28/11 22:30 local
    expect(r.start.toISOString()).toBe('2026-11-22T03:00:00.000Z');
  });
  it('respeita horário de verão: a semana tem 7 dias de relógio mesmo com 23/25h', () => {
    const r = weekRange(new Date('2026-03-04T12:00:00Z'), 'America/New_York'); // DST começa dom 8/mar
    expect(r.start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    const next = weekRange(new Date('2026-03-10T12:00:00Z'), 'America/New_York');
    expect(next.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(next.end.toISOString()).toBe('2026-03-15T04:00:00.000Z'); // já em UTC-4
  });
});

describe('goalStatus', () => {
  it('cumprida, coberta pelo agendado, pendente e desligada', () => {
    expect(goalStatus(1, 1, 0)).toBe('DONE');
    expect(goalStatus(2, 2, 5)).toBe('DONE');
    expect(goalStatus(1, 0, 1)).toBe('SCHEDULED');
    expect(goalStatus(3, 1, 1)).toBe('PENDING');
    expect(goalStatus(1, 0, 0)).toBe('PENDING');
    expect(goalStatus(0, 0, 0)).toBe('OFF');
  });
});

describe('kindsFor', () => {
  it('story só no Facebook e no Instagram', () => {
    expect(kindsFor('FACEBOOK')).toEqual(['POST', 'STORY']);
    expect(kindsFor('INSTAGRAM')).toEqual(['POST', 'STORY']);
    expect(kindsFor('YOUTUBE')).toEqual(['POST']);
    expect(kindsFor('TIKTOK')).toEqual(['POST']);
  });
});
