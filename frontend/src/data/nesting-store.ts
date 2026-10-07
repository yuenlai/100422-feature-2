// 排料准入的本地持久化：排料标准、排料单、钢材可领用量、领用流水集中放在一个 key 下，
// 与通用业务数据（local-store.ts）分开，两边结构互不影响。

export type Verdict = '可排料' | '待复核' | '退回'

/** 排料标准：版本化，每次调整版本 +1，未排完的排料单按新版本重判。 */
export type NestingStandard = {
  version: number
  capacityLimit: number // 设备产能上限（件/班）
  utilizationFloor: number // 材料利用率下限（%）
  reviewBand: number // 复核带宽（百分点）：利用率低于下限但落在带宽内判「待复核」
  updatedAt: string
  updatedBy: string
}

export type NestingPlan = {
  id: number
  下料编号: string
  板厚规格: string
  零件数量: number
  排料方式: string
  材料利用率: number
  verdict: Verdict
  reason: string
  standardVersion: number // 判定所用的标准版本
  finished: boolean // 是否已排完：排完释放产能，且不再参与标准改版重判
  createdAt: string
}

/** 钢材可领用量台账：只记总量，已占用由领用流水汇总得出，保证两个入口扣的是同一本账。 */
export type SteelQuota = {
  规格: string
  总量: number
}

export type SteelRequisition = {
  id: number
  来源: string // 入口：钢板下料准入 / 钢材管理-领用登记
  规格: string
  数量: number
  关联单号: string
  createdAt: string
}

export type NestingState = {
  standard: NestingStandard
  plans: NestingPlan[]
  quotas: SteelQuota[]
  requisitions: SteelRequisition[]
  nextPlanId: number
  nextRequisitionId: number
}

const STORAGE_KEY = 'ship-block-construction:nesting'
const LOCK_KEY = 'ship-block-construction:nesting-lock'
const LOCK_TTL_MS = 5000

function seedState(): NestingState {
  const now = new Date().toISOString()
  return {
    standard: {
      version: 1,
      capacityLimit: 200,
      utilizationFloor: 85,
      reviewBand: 5,
      updatedAt: now,
      updatedBy: '系统初始化',
    },
    plans: [
      {
        id: 1,
        下料编号: 'CUT-2026-0001',
        板厚规格: '12mm',
        零件数量: 60,
        排料方式: '自动套料',
        材料利用率: 91,
        verdict: '可排料',
        reason: '产能与材料利用率均达标',
        standardVersion: 1,
        finished: false,
        createdAt: now,
      },
      {
        id: 2,
        下料编号: 'CUT-2026-0002',
        板厚规格: '16mm',
        零件数量: 45,
        排料方式: '手工排料',
        材料利用率: 83,
        verdict: '待复核',
        reason: '材料利用率低于下限 85%，落在复核带宽内',
        standardVersion: 1,
        finished: false,
        createdAt: now,
      },
    ],
    quotas: [
      { 规格: '10mm', 总量: 500 },
      { 规格: '12mm', 总量: 400 },
      { 规格: '16mm', 总量: 300 },
      { 规格: '20mm', 总量: 200 },
    ],
    requisitions: [
      { id: 1, 来源: '钢板下料准入', 规格: '12mm', 数量: 60, 关联单号: 'CUT-2026-0001', createdAt: now },
      { id: 2, 来源: '钢板下料准入', 规格: '16mm', 数量: 45, 关联单号: 'CUT-2026-0002', createdAt: now },
    ],
    nextPlanId: 3,
    nextRequisitionId: 3,
  }
}

// 浏览器里走全局 localStorage；测试环境注入 globalThis.localStorage 也能用。
function storage(): Storage | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return null
}

let cache: NestingState | null = null

function readState(): NestingState {
  const store = storage()
  if (!store) {
    return seedState()
  }
  const raw = store.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedState()
    store.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return JSON.parse(raw) as NestingState
  } catch {
    const seeded = seedState()
    store.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

export function loadNestingState(): NestingState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function saveNestingState(state: NestingState): void {
  cache = state
  const store = storage()
  if (store) {
    store.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

/** 丢掉内存缓存重读存储：抢到锁之后先调它，保证看到的是其它标签页刚写入的最新数据。 */
export function refreshNestingState(): NestingState {
  cache = readState()
  return cache
}

export function resetNestingState(): NestingState {
  const seeded = seedState()
  saveNestingState(seeded)
  return seeded
}

// ---- 抢排锁：先锁定者落库，后到者直接拒绝。锁写进 localStorage，跨标签页同样生效。 ----

type LockRecord = { token: string; expiresAt: number }

function readLock(): LockRecord | null {
  const store = storage()
  if (!store) {
    return null
  }
  const raw = store.getItem(LOCK_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as LockRecord
  } catch {
    return null
  }
}

export function acquireNestingLock(token: string): boolean {
  const store = storage()
  if (!store) {
    return true // 没有存储能力时退化为单线程，直接放行
  }
  const now = Date.now()
  const current = readLock()
  if (current && current.expiresAt > now && current.token !== token) {
    return false
  }
  store.setItem(LOCK_KEY, JSON.stringify({ token, expiresAt: now + LOCK_TTL_MS }))
  return true
}

export function releaseNestingLock(token: string): void {
  const store = storage()
  if (!store) {
    return
  }
  const current = readLock()
  if (current && current.token === token) {
    store.removeItem(LOCK_KEY)
  }
}

/** 仅供测试/排障：查看当前锁被谁持有。 */
export function inspectNestingLock(): LockRecord | null {
  return readLock()
}
