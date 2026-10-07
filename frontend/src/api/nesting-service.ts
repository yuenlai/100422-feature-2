import {
  currentNestingStandard,
  saveNestingStandard,
  type NestingStandard,
} from '@/data/nesting-standard'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 钢板下料的准入闸口，规则全部收在这里，页面不做业务判断：
// 1. 下料编号、板厚规格、零件数量、排料方式填齐后才受理；
// 2. 按设备产能与材料利用率下限判定「可排料 / 待复核 / 退回」，冲突时以设备产能为准，
//    超产能上限的排料单直接退回、不落库；
// 3. 落库的同时按板厚规格扣减钢材管理里的可领用量，其它入口看到的可领量是一致的；
// 4. 同一下料编号重复抢排只记一次；并发抢排只让先拿到锁定的落库；
// 5. 排料标准换过以后，没排完（待排料 / 排料中）的按新标准重判。

export type NestingInput = {
  下料编号: string
  板厚规格: string
  零件数量: number
  排料方式: string
  材料利用率: number
  下料设备: string
  关联分段?: string
  操作人员?: string
}

export type NestingVerdict = '可排料' | '待复核' | '退回'

export type NestingSubmitResult = ActionResult & { verdict?: NestingVerdict }

export type RejudgeSummary = {
  total: number
  kept: number
  review: number
  rejected: number
}

export type StandardUpdateResult = ActionResult & {
  standard?: NestingStandard
  rejudge?: RejudgeSummary
}

/** 准入必须先填齐的四项 */
const REQUIRED_FIELDS = ['下料编号', '板厚规格', '零件数量', '排料方式'] as const

/** 没排完的状态：标准变更后只重判这些，已下料、已报验的不再动 */
const UNFINISHED_STATUSES = ['待排料', '排料中']

/** 还压在设备上的状态：核算设备产能占用时算这些 */
const CAPACITY_HOLDING_STATUSES = ['待排料', '排料中', '下料中']

/** 只有已检验放行的批次才参与可领用量扣减 */
const DEDUCTIBLE_STATUSES = ['已入库', '已发放']

export { currentNestingStandard }

function partsOf(row: EntryRow): number {
  return Number(row['零件数量']) || 0
}

/** 某台设备当前已占用的产能（还没从设备上下来的任务零件数合计） */
export function capacityUsed(rows: EntryRow[], device: string): number {
  return rows
    .filter(
      (row) =>
        String(row['下料设备']) === device &&
        CAPACITY_HOLDING_STATUSES.includes(String(row.status)),
    )
    .reduce((sum, row) => sum + partsOf(row), 0)
}

/**
 * 准入判定：设备产能与材料利用率冲突时以设备产能为准——
 * 产能超上限一律退回；产能够、利用率不够才降级为待复核。
 */
export function judgeNesting(
  input: Pick<NestingInput, '下料设备' | '零件数量' | '材料利用率'>,
  rows: EntryRow[],
  standard: NestingStandard,
): { verdict: NestingVerdict; capacityAfter: number } {
  const capacityAfter = capacityUsed(rows, input.下料设备) + input.零件数量
  if (capacityAfter > standard.capacityLimit) {
    return { verdict: '退回', capacityAfter }
  }
  if (input.材料利用率 < standard.utilizationFloor) {
    return { verdict: '待复核', capacityAfter }
  }
  return { verdict: '可排料', capacityAfter }
}

// ---- 抢排锁：localStorage 跨标签页可见，写后复读确认持锁人是自己 ----

const LOCK_KEY = 'ship-block-construction:nesting-locks'
const LOCK_TTL_MS = 8000

type LockTable = Record<string, { token: string; expires: number }>

// 没有 localStorage 的环境（SSR、测试）退化成进程内锁，逻辑保持一致
const memoryLocks: LockTable = {}

function readLocks(): LockTable {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...memoryLocks }
  }
  try {
    return JSON.parse(window.localStorage.getItem(LOCK_KEY) ?? '{}') as LockTable
  } catch {
    return {}
  }
}

function writeLocks(locks: LockTable): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LOCK_KEY, JSON.stringify(locks))
    return
  }
  for (const key of Object.keys(memoryLocks)) {
    delete memoryLocks[key]
  }
  Object.assign(memoryLocks, locks)
}

function acquireLock(name: string): string | null {
  const now = Date.now()
  const token = `${now}-${Math.random().toString(36).slice(2)}`
  const locks = readLocks()
  // 顺手清掉过期锁，避免异常退出的窗口把锁占死
  const alive: LockTable = Object.fromEntries(
    Object.entries(locks).filter(([, lock]) => lock.expires > now),
  )
  if (alive[name]) {
    return null
  }
  alive[name] = { token, expires: now + LOCK_TTL_MS }
  writeLocks(alive)
  const confirmed = readLocks()[name]
  return confirmed && confirmed.token === token ? token : null
}

function releaseLock(name: string, token: string): void {
  const locks = readLocks()
  if (locks[name]?.token === token) {
    delete locks[name]
    writeLocks(locks)
  }
}

// ---- 钢材可领用量扣减 ----

export type DeductionResult = { deducted: number; shortage: number }

/** 按板厚规格匹配钢材批次，按批次顺序扣减可领用量，并把领用记录写回钢材管理 */
export function deductMaterialStock(spec: string, quantity: number, refNo: string): DeductionResult {
  const rows = listRows('material')
  let remaining = quantity
  let deducted = 0
  const next = rows.map((row) => {
    if (remaining <= 0) {
      return row
    }
    if (String(row['规格尺寸']) !== spec || !DEDUCTIBLE_STATUSES.includes(String(row.status))) {
      return row
    }
    const available = Number(row['可领用量']) || 0
    if (available <= 0) {
      return row
    }
    const take = Math.min(available, remaining)
    remaining -= take
    deducted += take
    const log = String(row['领用记录'] ?? '').trim()
    const entry = `${refNo} 领用 ${take} 件`
    return {
      ...row,
      可领用量: available - take,
      领用记录: log ? `${log}；${entry}` : entry,
    }
  })
  if (deducted > 0) {
    saveRows('material', next)
  }
  return { deducted, shortage: remaining }
}

function deductionNote(refNo: string, deduction: DeductionResult): string {
  if (deduction.deducted === 0) {
    return `；钢材侧未扣减（没有匹配 ${refNo} 板厚规格的可领批次）`
  }
  if (deduction.shortage > 0) {
    return `；钢材可领用量已扣 ${deduction.deducted} 件，缺口 ${deduction.shortage} 件`
  }
  return `；钢材可领用量已一并扣减 ${deduction.deducted} 件`
}

// ---- 准入提交 ----

function normalizeInput(raw: NestingInput): NestingInput {
  return {
    ...raw,
    下料编号: String(raw.下料编号 ?? '').trim(),
    板厚规格: String(raw.板厚规格 ?? '').trim(),
    排料方式: String(raw.排料方式 ?? '').trim(),
    下料设备: String(raw.下料设备 ?? '').trim(),
    关联分段: String(raw.关联分段 ?? '').trim(),
    操作人员: String(raw.操作人员 ?? '').trim(),
    零件数量: Math.trunc(Number(raw.零件数量)),
    材料利用率: Number(raw.材料利用率),
  }
}

function validateInput(input: NestingInput): string | null {
  for (const field of REQUIRED_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' ? value === '' : !Number.isFinite(value) || value <= 0) {
      return `准入要先填齐「${REQUIRED_FIELDS.join('、')}」，当前「${field}」不合规`
    }
  }
  if (input.下料设备 === '') {
    return '设备产能按单台设备核算，请填「下料设备」'
  }
  if (!Number.isFinite(input.材料利用率) || input.材料利用率 < 0 || input.材料利用率 > 100) {
    return '材料利用率要是 0-100 之间的数字'
  }
  return null
}

function duplicateResult(row: EntryRow): NestingSubmitResult {
  return {
    ok: true,
    verdict: String(row['准入结论'] ?? '可排料') as NestingVerdict,
    message: `排料单 ${row['下料编号']} 已登记（准入结论「${row['准入结论'] ?? '—'}」），重复抢排只记一次，本次未重复落库`,
  }
}

export function submitNesting(raw: NestingInput): NestingSubmitResult {
  const input = normalizeInput(raw)
  const invalid = validateInput(input)
  if (invalid) {
    return { ok: false, message: invalid }
  }

  // 锁外先查一次，明显的重复直接挡掉
  const existing = listRows('cutting').find((row) => String(row['下料编号']) === input.下料编号)
  if (existing) {
    return duplicateResult(existing)
  }

  const lockName = `nesting:${input.下料编号}`
  const token = acquireLock(lockName)
  if (!token) {
    return {
      ok: false,
      message: `排料单 ${input.下料编号} 正被其它窗口抢排，未抢到锁定，本次未落库`,
    }
  }
  try {
    // 拿到锁后再查一次：等锁期间可能已经被别的窗口落库
    const rows = listRows('cutting')
    const duplicated = rows.find((row) => String(row['下料编号']) === input.下料编号)
    if (duplicated) {
      return duplicateResult(duplicated)
    }

    const standard = currentNestingStandard()
    const { verdict, capacityAfter } = judgeNesting(input, rows, standard)
    if (verdict === '退回') {
      return {
        ok: false,
        verdict,
        message: `排料单 ${input.下料编号} 判定「退回」：设备 ${input.下料设备} 产能占用将达 ${capacityAfter}/${standard.capacityLimit} 件，超上限的排料单不落库`,
      }
    }

    const row: EntryRow = {
      id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
      status: '待排料',
      pending: true,
      abnormal: verdict === '待复核',
      下料编号: input.下料编号,
      关联分段: input.关联分段 ?? '',
      板厚规格: input.板厚规格,
      零件数量: input.零件数量,
      排料方式: input.排料方式,
      下料设备: input.下料设备,
      操作人员: input.操作人员 ?? '',
      材料利用率: input.材料利用率,
      准入结论: verdict,
      标准版本: standard.version,
      下料状态: '待排料',
    }
    saveRows('cutting', [...rows, row])

    const deduction = deductMaterialStock(input.板厚规格, input.零件数量, input.下料编号)
    const note = deductionNote(input.板厚规格, deduction)
    if (verdict === '待复核') {
      return {
        ok: true,
        verdict,
        message: `排料单 ${input.下料编号} 判定「待复核」：材料利用率 ${input.材料利用率}% 低于下限 ${standard.utilizationFloor}%，已落库待人工复核${note}`,
      }
    }
    return {
      ok: true,
      verdict,
      message: `排料单 ${input.下料编号} 判定「可排料」（设备产能占用 ${capacityAfter}/${standard.capacityLimit} 件），已登记为「待排料」${note}`,
    }
  } finally {
    releaseLock(lockName, token)
  }
}

// ---- 标准变更与重判 ----

/**
 * 没排完的排料单按新标准重判：下料中的占用不动，未排完的按登记顺序重新累计；
 * 重判为退回的保留记录、标异常待处理，且不再占设备产能，避免永远卡死。
 */
export function rejudgeUnfinished(standard: NestingStandard): RejudgeSummary {
  const rows = listRows('cutting')
  const occupied = new Map<string, number>()
  for (const row of rows) {
    if (String(row.status) === '下料中') {
      const device = String(row['下料设备'])
      occupied.set(device, (occupied.get(device) ?? 0) + partsOf(row))
    }
  }

  const targets = rows
    .filter((row) => UNFINISHED_STATUSES.includes(String(row.status)))
    .sort((a, b) => Number(a.id) - Number(b.id))

  const verdictById = new Map<number, NestingVerdict>()
  const summary: RejudgeSummary = { total: targets.length, kept: 0, review: 0, rejected: 0 }
  for (const row of targets) {
    const device = String(row['下料设备'])
    const used = occupied.get(device) ?? 0
    const utilization = Number(row['材料利用率']) || 0
    let verdict: NestingVerdict
    if (used + partsOf(row) > standard.capacityLimit) {
      verdict = '退回'
    } else if (utilization < standard.utilizationFloor) {
      verdict = '待复核'
      occupied.set(device, used + partsOf(row))
    } else {
      verdict = '可排料'
      occupied.set(device, used + partsOf(row))
    }
    verdictById.set(Number(row.id), verdict)
    if (verdict === '退回') {
      summary.rejected += 1
    } else if (verdict === '待复核') {
      summary.review += 1
    } else {
      summary.kept += 1
    }
  }

  const next = rows.map((row) => {
    const verdict = verdictById.get(Number(row.id))
    if (!verdict) {
      return row
    }
    return { ...row, 准入结论: verdict, 标准版本: standard.version, abnormal: verdict !== '可排料' }
  })
  saveRows('cutting', next)
  return summary
}

export function updateNestingStandard(
  capacityLimit: number,
  utilizationFloor: number,
): StandardUpdateResult {
  if (!Number.isFinite(capacityLimit) || capacityLimit <= 0) {
    return { ok: false, message: '设备产能上限要是大于 0 的数字' }
  }
  if (!Number.isFinite(utilizationFloor) || utilizationFloor < 0 || utilizationFloor > 100) {
    return { ok: false, message: '材料利用率下限要在 0-100 之间' }
  }
  const current = currentNestingStandard()
  if (current.capacityLimit === capacityLimit && current.utilizationFloor === utilizationFloor) {
    return { ok: false, message: '新标准与现行标准一致，没有变化，未升版本' }
  }
  const standard = saveNestingStandard(Math.trunc(capacityLimit), utilizationFloor)
  const rejudge = rejudgeUnfinished(standard)
  return {
    ok: true,
    standard,
    rejudge,
    message: `排料标准已更新为 v${standard.version}（产能上限 ${standard.capacityLimit} 件/班、利用率下限 ${standard.utilizationFloor}%），${rejudge.total} 条未排完记录已按新标准重判：可排料 ${rejudge.kept}、待复核 ${rejudge.review}、退回 ${rejudge.rejected}`,
  }
}
