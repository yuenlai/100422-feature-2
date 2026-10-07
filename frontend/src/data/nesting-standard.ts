// 排料标准：设备产能上限与材料利用率下限都从这里读。
// 标准换过以后会升版本号，没排完的排料单按新标准重判（见 api/nesting-service.ts）。
export type NestingStandard = {
  version: number
  /** 单台下料设备一个班次可排的零件数上限 */
  capacityLimit: number
  /** 材料利用率下限（%），低于它降级为待复核 */
  utilizationFloor: number
  updatedAt: string
}

const STANDARD_KEY = 'ship-block-construction:nesting-standard'

export const DEFAULT_NESTING_STANDARD: NestingStandard = {
  version: 1,
  capacityLimit: 100,
  utilizationFloor: 85,
  updatedAt: '2026-10-01',
}

function pickNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

// 没有 localStorage 的环境（SSR、测试）退化成进程内副本
let memoryStandard: NestingStandard | null = null

export function currentNestingStandard(): NestingStandard {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...(memoryStandard ?? DEFAULT_NESTING_STANDARD) }
  }
  const raw = window.localStorage.getItem(STANDARD_KEY)
  if (!raw) {
    window.localStorage.setItem(STANDARD_KEY, JSON.stringify(DEFAULT_NESTING_STANDARD))
    return { ...DEFAULT_NESTING_STANDARD }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NestingStandard>
    return {
      version: pickNumber(parsed.version, DEFAULT_NESTING_STANDARD.version),
      capacityLimit: pickNumber(parsed.capacityLimit, DEFAULT_NESTING_STANDARD.capacityLimit),
      utilizationFloor: pickNumber(parsed.utilizationFloor, DEFAULT_NESTING_STANDARD.utilizationFloor),
      updatedAt: String(parsed.updatedAt ?? DEFAULT_NESTING_STANDARD.updatedAt),
    }
  } catch {
    window.localStorage.setItem(STANDARD_KEY, JSON.stringify(DEFAULT_NESTING_STANDARD))
    return { ...DEFAULT_NESTING_STANDARD }
  }
}

export function saveNestingStandard(capacityLimit: number, utilizationFloor: number): NestingStandard {
  const previous = currentNestingStandard()
  const next: NestingStandard = {
    version: previous.version + 1,
    capacityLimit,
    utilizationFloor,
    updatedAt: new Date().toISOString().slice(0, 10),
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STANDARD_KEY, JSON.stringify(next))
  } else {
    memoryStandard = next
  }
  return next
}
