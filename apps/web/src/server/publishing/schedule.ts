import { UserError } from '../errors';
import { formatInZone } from './time';

/** Intervalo mínimo entre duas publicações da MESMA conta (min). Evita agendar de novo no mesmo horário. */
export function minGapMinutes(): number {
  const n = Number(process.env.PUBLISH_MIN_GAP_MINUTES);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** Quanto tempo no futuro dá para agendar (dias). */
export const MAX_SCHEDULE_DAYS = 365;

/** Horários já ocupados que ficam a menos de `gapMinutes` do horário pedido (em qualquer direção). */
export function findSlotConflicts(existing: Date[], wanted: Date, gapMinutes: number): Date[] {
  if (gapMinutes <= 0) return existing.filter((e) => e.getTime() === wanted.getTime());
  const gap = gapMinutes * 60_000;
  return existing.filter((e) => Math.abs(e.getTime() - wanted.getTime()) < gap).sort((a, b) => a.getTime() - b.getTime());
}

/** Agendamento precisa estar no futuro (com folga p/ o worker pegar) e dentro do limite. */
export function assertSchedulable(wanted: Date, now = new Date()): void {
  if (Number.isNaN(wanted.getTime())) throw new UserError('Data e hora inválidas.');
  if (wanted.getTime() < now.getTime() + 60_000) throw new UserError('O horário do agendamento precisa estar pelo menos 1 minuto no futuro.');
  if (wanted.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) throw new UserError(`Só dá para agendar até ${MAX_SCHEDULE_DAYS} dias à frente.`);
}

export interface AccountSlots {
  accountName: string;
  platform: string;
  /** Publicações dessa conta já agendadas/em andamento/publicadas. */
  taken: Date[];
}

/** Mensagem única listando cada conta em conflito e o horário que a bloqueia. */
export function describeConflicts(slots: AccountSlots[], wanted: Date, gapMinutes: number, tz: string): string | null {
  const lines: string[] = [];
  for (const s of slots) {
    const hit = findSlotConflicts(s.taken, wanted, gapMinutes);
    if (hit.length) lines.push(`${s.accountName} (${s.platform}) já tem publicação em ${hit.map((h) => formatInZone(h, tz)).join(', ')}`);
  }
  if (!lines.length) return null;
  return (
    `Horário muito próximo de outra publicação (intervalo mínimo de ${gapMinutes} min por conta): ${lines.join('; ')}. ` +
    'Escolha outro horário ou marque "ignorar o intervalo mínimo".'
  );
}
