import type { PlanForm } from '../api';

/** Use scheduling's dates and presale configuration for every plan mode. */
export async function resolvePlanSearchTarget(
  form: PlanForm,
  preview: (form: PlanForm) => Promise<Array<{ travelDate: string; estimatedSaleDate: string }>>,
): Promise<{ travelDate: string; estimatedSaleDate: string } | null> {
  const dates = await preview(form);
  return dates[0] ?? null;
}
