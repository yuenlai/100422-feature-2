import {
  acquireNestingLock,
  loadNestingState,
  refreshNestingState,
  releaseNestingLock,
  saveNestingState,
} from '@/data/nesting-store'
import type {
  NestingPlan,
  NestingStandard,
  SteelRequisition,
  Verdict,
} from '@/data/nesting-store'

// 排料准入门：必填校验 → 幂等 → 抢锁 → 判定 → 落库并联动扣减钢材可领用量。
// 判定维度是设备产能与材料利用率下限；两者冲突时以设备产能为准，超上限的排料单不落库。

export type PlanInput = {
  下料编号: string
  板厚规格: string
  零件数量: number
  排料方式: string
  材料利用率: number
}

export type GateResult = {
  ok: boolean
  message: string
  verdict?: Verdict
  duplicated?: boolean
}

export type QuotaView = {
  规格: string
  总量: number
  已占用: number
  可领: number
}

export type RejudgeChange = {
  下料编号: string
  from: Verdict
  to: Verdict
}

export type StandardResult = {
  ok: boolean
  message: string
  version?: number
  rejudged: RejudgeChange[]
}

const REQUIRED_FIELDS: (keyof Pick<PlanInput, '下料编号' | '板厚规格' | '排料方式'>)[] = [
  '下料编号',
  '板厚规格',
  '排料方式',
]

/** 判定纯函数：产能冲突优先，超上限直接退回；利用率按下限与复核带宽分档。 */
export function judgePlan(
  partCount: number,
  utilization: number,
  standard: Pick<NestingStandard, 'capacityLimit' | 'utilizationFloor' | 'reviewBand'>,
  remainingCapacity: number,
): { verdict: Verdict; reason: string } {
  if (partCount > remainingCapacity) {
    return {
      verdict: '退回',
      reason: `需求 ${partCount} 件超出设备剩余产能 ${remainingCapacity} 件，以设备产能为准`,
    }
  }
  if (utilization >= standard.utilizationFloor) {
    return { verdict: '可排料', reason: '产能与材料利用率均达标' }
  }
  if (utilization >= standard.utilizationFloor - standard.reviewBand) {
    return {
      verdict: '待复核',
      reason: `材料利用率低于下限 ${standard.utilizationFloor}%，落在复核带宽内`,
    }
  }
  return {
    verdict: '退回',
    reason: `材料利用率低于复核下限 ${standard.utilizationFloor - standard.reviewBand}%`,
  }
}

/** 剩余产能：上限减去未排完且已占位（可排料/待复核）排料单的零件数。 */
export function remainingCapacity(): number {
  const state = loadNestingState()
  const occupied = state.plans
    .filter((plan) => !plan.finished && plan.verdict !== '退回')
    .reduce((sum, plan) => sum + plan.零件数量, 0)
  return state.standard.capacityLimit - occupied
}

/** 可领用量台账：总量减去各入口领用流水的合计，排料准入与其它入口扣的是同一本账。 */
export function listQuotas(): QuotaView[] {
  const state = loadNestingState()
  return state.quotas.map((quota) => {
    const used = state.requisitions
      .filter((item) => item.规格 === quota.规格)
      .reduce((sum, item) => sum + item.数量, 0)
    return { 规格: quota.规格, 总量: quota.总量, 已占用: used, 可领: quota.总量 - used }
  })
}

export function listPlans(): NestingPlan[] {
  return [...loadNestingState().plans].sort((a, b) => b.id - a.id)
}

export function listRequisitions(): SteelRequisition[] {
  return [...loadNestingState().requisitions].sort((a, b) => b.id - a.id)
}

export function currentStandard(): NestingStandard {
  return loadNestingState().standard
}

function makeToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 在锁内执行写操作：先锁定者落库，后到者直接失败；进锁后先刷新，读到其它标签页的最新写入。 */
function withLock<T>(fn: () => T): T | { ok: false; message: string } {
  const token = makeToken()
  if (!acquireNestingLock(token)) {
    return { ok: false, message: '并发抢排冲突：已有提交先锁定，仅先锁定者落库，请稍后重试' }
  }
  try {
    refreshNestingState()
    return fn()
  } finally {
    releaseNestingLock(token)
  }
}

function validateInput(input: PlanInput): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (!String(input[field] ?? '').trim()) {
      return `${field}未填，准入四项（下料编号、板厚规格、零件数量、排料方式）必须填齐`
    }
  }
  if (!Number.isFinite(input.零件数量) || input.零件数量 <= 0) {
    return '零件数量必须为正数'
  }
  if (!Number.isFinite(input.材料利用率) || input.材料利用率 <= 0 || input.材料利用率 > 100) {
    return '材料利用率须在 0~100% 之间'
  }
  return null
}

/** 登记排料单并走准入门。重复抢排（同一下料编号）只记一次，直接返回已有判定。 */
export function submitPlan(input: PlanInput): GateResult {
  const invalid = validateInput(input)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const outcome = withLock<GateResult>(() => {
    const state = loadNestingState()
    const existing = state.plans.find((plan) => plan.下料编号 === input.下料编号.trim())
    if (existing) {
      return {
        ok: true,
        duplicated: true,
        verdict: existing.verdict,
        message: `下料编号 ${existing.下料编号} 已受理（${existing.verdict}），重复抢排只记一次`,
      }
    }
    const remaining =
      state.standard.capacityLimit -
      state.plans
        .filter((plan) => !plan.finished && plan.verdict !== '退回')
        .reduce((sum, plan) => sum + plan.零件数量, 0)
    const { verdict, reason } = judgePlan(input.零件数量, input.材料利用率, state.standard, remaining)
    if (verdict === '退回' && input.零件数量 > remaining) {
      // 超设备产能上限：退回且不落库
      return { ok: false, verdict, message: `准入退回：${reason}，超上限的排料单不予落库` }
    }
    if (verdict !== '退回') {
      const quota = state.quotas.find((item) => item.规格 === input.板厚规格.trim())
      if (!quota) {
        return { ok: false, message: `板厚规格 ${input.板厚规格} 没有对应的钢材台账，无法扣减可领用量` }
      }
      const used = state.requisitions
        .filter((item) => item.规格 === quota.规格)
        .reduce((sum, item) => sum + item.数量, 0)
      if (quota.总量 - used < input.零件数量) {
        return {
          ok: false,
          message: `规格 ${quota.规格} 可领用量不足（剩余 ${quota.总量 - used} 件），排料单不予落库`,
        }
      }
      state.requisitions.push({
        id: state.nextRequisitionId,
        来源: '钢板下料准入',
        规格: quota.规格,
        数量: input.零件数量,
        关联单号: input.下料编号.trim(),
        createdAt: new Date().toISOString(),
      })
      state.nextRequisitionId += 1
    }
    state.plans.push({
      id: state.nextPlanId,
      下料编号: input.下料编号.trim(),
      板厚规格: input.板厚规格.trim(),
      零件数量: input.零件数量,
      排料方式: input.排料方式.trim(),
      材料利用率: input.材料利用率,
      verdict,
      reason,
      standardVersion: state.standard.version,
      finished: false,
      createdAt: new Date().toISOString(),
    })
    state.nextPlanId += 1
    saveNestingState(state)
    return { ok: true, verdict, message: `准入门判定：${verdict}。${reason}` }
  })
  return outcome
}

/** 调整排料标准：版本 +1，未排完的排料单按新标准重判（产能与材料占用一并重算）。 */
export function changeStandard(input: {
  capacityLimit: number
  utilizationFloor: number
  reviewBand?: number
  operator: string
}): StandardResult {
  if (!Number.isFinite(input.capacityLimit) || input.capacityLimit <= 0) {
    return { ok: false, message: '设备产能上限必须为正数', rejudged: [] }
  }
  if (
    !Number.isFinite(input.utilizationFloor) ||
    input.utilizationFloor <= 0 ||
    input.utilizationFloor > 100
  ) {
    return { ok: false, message: '材料利用率下限须在 0~100% 之间', rejudged: [] }
  }
  const outcome = withLock<StandardResult>(() => {
    const state = loadNestingState()
    const standard: NestingStandard = {
      version: state.standard.version + 1,
      capacityLimit: input.capacityLimit,
      utilizationFloor: input.utilizationFloor,
      reviewBand: input.reviewBand ?? state.standard.reviewBand,
      updatedAt: new Date().toISOString(),
      updatedBy: input.operator,
    }
    state.standard = standard

    // 重判：先回冲所有未排完单的领用流水，再按创建顺序用新标准逐单重判、重新占用。
    const pending = state.plans
      .filter((plan) => !plan.finished)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
    const pendingCodes = new Set(pending.map((plan) => plan.下料编号))
    state.requisitions = state.requisitions.filter(
      (item) => !(item.来源 === '钢板下料准入' && pendingCodes.has(item.关联单号)),
    )

    const rejudged: RejudgeChange[] = []
    let remaining = standard.capacityLimit
    for (const plan of pending) {
      const before = plan.verdict
      const { verdict, reason } = judgePlan(plan.零件数量, plan.材料利用率, standard, remaining)
      let finalVerdict = verdict
      let finalReason = reason
      if (verdict !== '退回') {
        const quota = state.quotas.find((item) => item.规格 === plan.板厚规格)
        const used = quota
          ? state.requisitions
              .filter((item) => item.规格 === quota.规格)
              .reduce((sum, item) => sum + item.数量, 0)
          : 0
        if (!quota || quota.总量 - used < plan.零件数量) {
          finalVerdict = '退回'
          finalReason = `重判时规格 ${plan.板厚规格} 可领用量不足，转为退回`
        } else {
          remaining -= plan.零件数量
          state.requisitions.push({
            id: state.nextRequisitionId,
            来源: '钢板下料准入',
            规格: quota.规格,
            数量: plan.零件数量,
            关联单号: plan.下料编号,
            createdAt: new Date().toISOString(),
          })
          state.nextRequisitionId += 1
        }
      }
      plan.verdict = finalVerdict
      plan.reason = finalReason
      plan.standardVersion = standard.version
      if (before !== finalVerdict) {
        rejudged.push({ 下料编号: plan.下料编号, from: before, to: finalVerdict })
      }
    }
    saveNestingState(state)
    return {
      ok: true,
      version: standard.version,
      rejudged,
      message: `排料标准已切换至 v${standard.version}，${pending.length} 张未排完排料单已按新标准重判`,
    }
  })
  if (!('rejudged' in outcome)) {
    return { ok: false, message: outcome.message, rejudged: [] }
  }
  return outcome
}

/** 其它入口的钢材领用：与排料准入共用同一本可领用量台账，一并扣减。 */
export function registerRequisition(input: {
  规格: string
  数量: number
  来源: string
  关联单号: string
}): GateResult {
  if (!input.规格.trim()) {
    return { ok: false, message: '领用规格未填' }
  }
  if (!Number.isFinite(input.数量) || input.数量 <= 0) {
    return { ok: false, message: '领用数量必须为正数' }
  }
  const outcome = withLock<GateResult>(() => {
    const state = loadNestingState()
    const quota = state.quotas.find((item) => item.规格 === input.规格.trim())
    if (!quota) {
      return { ok: false, message: `规格 ${input.规格} 没有对应的钢材台账` }
    }
    const used = state.requisitions
      .filter((item) => item.规格 === quota.规格)
      .reduce((sum, item) => sum + item.数量, 0)
    const left = quota.总量 - used
    if (left < input.数量) {
      return { ok: false, message: `规格 ${quota.规格} 可领用量不足：剩余 ${left}，本次申请 ${input.数量}` }
    }
    state.requisitions.push({
      id: state.nextRequisitionId,
      来源: input.来源.trim() || '钢材管理-领用登记',
      规格: quota.规格,
      数量: input.数量,
      关联单号: input.关联单号.trim() || '—',
      createdAt: new Date().toISOString(),
    })
    state.nextRequisitionId += 1
    saveNestingState(state)
    return { ok: true, message: `已登记领用：${quota.规格} × ${input.数量}，剩余可领 ${left - input.数量}` }
  })
  return outcome
}

/** 标记排完：释放产能占用，不再参与标准改版重判；已领钢材不回冲。 */
export function markPlanFinished(id: number): GateResult {
  const outcome = withLock<GateResult>(() => {
    const state = loadNestingState()
    const plan = state.plans.find((item) => item.id === id)
    if (!plan) {
      return { ok: false, message: `没有找到编号为 ${id} 的排料单` }
    }
    if (plan.finished) {
      return { ok: false, message: `排料单 ${plan.下料编号} 已排完，不用重复操作` }
    }
    plan.finished = true
    saveNestingState(state)
    return { ok: true, message: `排料单 ${plan.下料编号} 已标记排完，产能占用已释放` }
  })
  return outcome
}
