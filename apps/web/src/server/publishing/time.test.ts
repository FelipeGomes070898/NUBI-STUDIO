import { describe, expect, it } from 'vitest';
import { formatInZone, isValidTimeZone, zonedToUtc } from './time';

describe('zonedToUtc', () => {
  it('Brasília (UTC-3, sem horário de verão): 14:30 local = 17:30 UTC', () => {
    expect(zonedToUtc('2026-11-26T14:30', 'America/Sao_Paulo').toISOString()).toBe('2026-11-26T17:30:00.000Z');
  });
  it('Rondônia (UTC-4)', () => {
    expect(zonedToUtc('2026-11-26T09:00', 'America/Porto_Velho').toISOString()).toBe('2026-11-26T13:00:00.000Z');
  });
  it('vira o dia corretamente (23:30 local → 02:30 UTC do dia seguinte)', () => {
    expect(zonedToUtc('2026-11-26T23:30', 'America/Sao_Paulo').toISOString()).toBe('2026-11-27T02:30:00.000Z');
  });
  it('respeita horário de verão (Nova York: verão UTC-4, inverno UTC-5)', () => {
    expect(zonedToUtc('2026-07-01T12:00', 'America/New_York').toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(zonedToUtc('2026-01-15T12:00', 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });
  it('UTC e fusos com meia hora (Índia +5:30)', () => {
    expect(zonedToUtc('2026-11-26T10:00', 'UTC').toISOString()).toBe('2026-11-26T10:00:00.000Z');
    expect(zonedToUtc('2026-11-26T10:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-26T04:30:00.000Z');
  });
  it('rejeita formato e datas impossíveis', () => {
    for (const bad of ['', '2026-11-26', '26/11/2026 10:00', '2026-02-30T10:00', '2026-11-26T25:00', '2026-11-26T10:60']) {
      expect(() => zonedToUtc(bad, 'UTC')).toThrow(/inválidas/);
    }
  });
});

describe('fuso', () => {
  it('valida nomes IANA', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('Marte/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
  it('formata no fuso pedido (ida e volta)', () => {
    const d = zonedToUtc('2026-11-26T14:30', 'America/Sao_Paulo');
    expect(formatInZone(d, 'America/Sao_Paulo')).toBe('26/11/2026, 14:30');
  });
});
