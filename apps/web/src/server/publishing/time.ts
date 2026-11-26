/** Fuso horário padrão quando o navegador não informa um (o app é usado no Brasil). */
export const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Quanto o relógio do fuso `tz` está à frente do UTC (em ms) no instante `utcMs`. */
function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converte o valor de um <input type="datetime-local"> ("2026-11-26T14:30"), que é hora de relógio no fuso do
 * usuário, para o instante UTC correto. Lança erro para formato inválido.
 */
export function zonedToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new Error('Data e hora inválidas.');
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) throw new Error('Data e hora inválidas.');
  // duas passadas: o deslocamento pode mudar entre o palpite e o resultado (horário de verão)
  let guess = asUtc - offsetMs(asUtc, tz);
  guess = asUtc - offsetMs(guess, tz);
  return new Date(guess);
}

/** "26/11/2026 14:30" no fuso informado (para mensagens de erro/auditoria geradas no servidor). */
export function formatInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(d);
}
