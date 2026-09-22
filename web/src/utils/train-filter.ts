/** Inclusive departure bounds; blank endpoints mean an unrestricted side. */
export function filterDepartureRange<T extends { departTime: string }>(trains: T[], from?: string | null, to?: string | null): T[] {
  return trains.filter(train => (!from || train.departTime >= from) && (!to || train.departTime <= to));
}
