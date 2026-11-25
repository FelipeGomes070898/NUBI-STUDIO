import Decimal from 'decimal.js';
import { UserError } from '@/server/errors';

export const str = (fd: FormData, k: string): string => String(fd.get(k) ?? '').trim();
export const optStr = (fd: FormData, k: string): string | undefined => str(fd, k) || undefined;
export const bool = (fd: FormData, k: string): boolean => fd.get(k) === 'on' || fd.get(k) === 'true';

/** Número decimal ≥ 0 a partir de texto (aceita vírgula). Vazio → null. */
export function money(fd: FormData, k: string, label: string): Decimal | null {
  const raw = str(fd, k).replace(',', '.');
  if (!raw) return null;
  let d: Decimal;
  try {
    d = new Decimal(raw);
  } catch {
    throw new UserError(`${label}: valor inválido.`);
  }
  if (!d.isFinite() || d.lt(0)) throw new UserError(`${label}: informe um valor maior ou igual a zero.`);
  return d;
}

export function oneOf<T extends string>(fd: FormData, k: string, allowed: readonly T[], label: string): T {
  const v = str(fd, k);
  if (!(allowed as readonly string[]).includes(v)) throw new UserError(`${label} inválido.`);
  return v as T;
}

export function int(fd: FormData, k: string, label: string, min: number, max: number): number | undefined {
  const raw = str(fd, k);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label}: informe um inteiro entre ${min} e ${max}.`);
  return n;
}
