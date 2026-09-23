import { PlansRepo, TasksRepo, PassengersRepo, PlanDateSkipsRepo } from '../db/repo.js';
import { getContext } from '../bot/session.js';
import { withUserLock } from '../bot/user-lock.js';
import { warmOrderPage, fetchCompletedOrders } from '../bot/orderApi.js';
import { assertCancelableOrder, CancellationRejected, cancelUnpaidOrder, strictIncompleteOrders, type CancelTarget } from '../bot/cancel-order.js';
import { Logger } from '../logger.js';

export async function cancelPlanOrderAndSkip(userId: string, planId: string, taskId: string, execute = executeCancellation): Promise<void> {
  return withUserLock(userId, async () => {
    const plan = PlansRepo.get(planId), task = TasksRepo.get(taskId);
    if (!plan || plan.userId !== userId || !task || task.planId !== planId || task.userId !== userId) throw new Error('计划或任务不存在');
    if (task.status === 'skipped' && PlanDateSkipsRepo.has(planId,task.travelDate)) return;
    if (task.status !== 'success' || task.result?.paid === true || typeof task.result?.orderNo !== 'string' || !task.result.orderNo) throw new Error('仅支持取消有订单号的待支付订单，请先刷新订单状态');
    const passengers = Array.isArray(task.result.passengers) && task.result.passengers.every(p => typeof p === 'string')
      ? task.result.passengers as string[] : PassengersRepo.list(userId).filter(p => plan.passengerIds.includes(p.id)).map(p => p.name);
    const target = { orderNo:task.result.orderNo, travelDate:task.travelDate, trainCode:String(task.result.trainCode ?? task.trainNumber ?? ''), passengers };
    let submitted = false;
    try {
      await execute(userId,target,() => {
        PlanDateSkipsRepo.beginCancellation(planId, task.travelDate, target.orderNo);
        submitted = true;
      }, PlanDateSkipsRepo.cancelling(planId, task.travelDate));
      PlanDateSkipsRepo.finishCancellation(planId,task.travelDate,target.orderNo);
      new Logger('plan',userId).info('已取消未支付订单并跳过乘车日期',{planId,taskId,travelDate:task.travelDate});
    } catch (e) {
      if (submitted && e instanceof CancellationRejected) PlanDateSkipsRepo.clearCancellation(planId,task.travelDate);
      if (submitted && !(e instanceof CancellationRejected)) throw new Error('取消结果待核实，已暂停该日期自动购票。请在 12306 核对订单；若仍待支付，可再次取消。');
      throw new Error(e instanceof CancellationRejected ? e.message : '取消前核对订单失败，请检查登录状态和网络后重试');
    }
  });
}
async function executeCancellation(userId: string, target: CancelTarget, beforeSubmit: () => void, verifyPrevious = false): Promise<void> {
  const context = await getContext(userId), page = await context.newPage();
  try {
    await warmOrderPage(page);
    const orders = await strictIncompleteOrders(page);
    if (verifyPrevious && !orders.some(o => o.sequence_no === target.orderNo)) {
      const completed = await fetchCompletedOrders(page,90,true);
      if (completed.some(o => o.sequence_no === target.orderNo)) throw new CancellationRejected('该订单存在已完成记录，请在 12306 核对，暂不跳过');
      return; // A prior uncertain cancellation is now absent from both authoritative lists.
    }
    assertCancelableOrder(orders,target);
    beforeSubmit();
    await cancelUnpaidOrder(page,target.orderNo);
  } finally { await page.close().catch(() => undefined); }
}
