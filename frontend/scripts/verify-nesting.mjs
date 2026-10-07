// 排料准入门核心逻辑验证：tsc 编译领域层后在 node 里跑断言，不引入测试框架。
// 运行：npm run verify:nesting
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath} from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(here, '..')
const outDir = resolve(frontendRoot, 'node_modules/.cache/nesting-verify')

// 1. 用项目自己的 typescript 编译领域层（环境里的 esbuild 是 mac 二进制，跑不了）。
execFileSync(
  process.execPath,
  [resolve(frontendRoot, 'node_modules/typescript/bin/tsc'), '-p', resolve(here, 'tsconfig.verify.json')],
  { stdio: 'inherit' },
)

// 2. tsc 不会改写 @/ 别名，手动把 service 里的别名引用换成相对路径。
const serviceFile = resolve(outDir, 'api/nesting-service.js')
writeFileSync(
  serviceFile,
  readFileSync(serviceFile, 'utf8').replaceAll('@/data/nesting-store', '../data/nesting-store.js'),
)

// 3. node 里没有 localStorage，注入内存版（store 的 storage() 会优先用它）。
class MemoryStorage {
  constructor() {
    this.map = new Map()
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    this.map.set(key, String(value))
  }
  removeItem(key) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}
globalThis.localStorage = new MemoryStorage()

const store = await import(resolve(outDir, 'data/nesting-store.js'))
const service = await import(serviceFile)
const { acquireNestingLock, inspectNestingLock, releaseNestingLock, resetNestingState } = store
const {
  changeStandard,
  currentStandard,
  listPlans,
  listQuotas,
  markPlanFinished,
  registerRequisition,
  remainingCapacity,
  submitPlan,
} = service

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function quotaOf(spec) {
  return listQuotas().find((item) => item.规格 === spec)
}

function planByCode(code) {
  return listPlans().find((item) => item.下料编号 === code)
}

// ---------- 1. 必填校验：四项填齐才受理 ----------
console.log('场景1：准入必填校验')
resetNestingState()
let result = submitPlan({ 下料编号: '', 板厚规格: '10mm', 零件数量: 10, 排料方式: '自动套料', 材料利用率: 90 })
check('缺下料编号被拒绝', !result.ok && result.message.includes('下料编号'))
result = submitPlan({ 下料编号: 'CUT-T1', 板厚规格: '', 零件数量: 10, 排料方式: '自动套料', 材料利用率: 90 })
check('缺板厚规格被拒绝', !result.ok && result.message.includes('板厚规格'))
result = submitPlan({ 下料编号: 'CUT-T1', 板厚规格: '10mm', 零件数量: 0, 排料方式: '自动套料', 材料利用率: 90 })
check('零件数量非正数被拒绝', !result.ok)
result = submitPlan({ 下料编号: 'CUT-T1', 板厚规格: '10mm', 零件数量: 10, 排料方式: '', 材料利用率: 90 })
check('缺排料方式被拒绝', !result.ok && result.message.includes('排料方式'))
check('非法提交均未落库', listPlans().length === 2) // 只剩种子两条

// ---------- 2. 判定分档：可排料 / 待复核 / 退回 ----------
console.log('场景2：按设备产能与材料利用率下限判定')
resetNestingState()
check('种子剩余产能 = 200-60-45 = 95', remainingCapacity() === 95)
result = submitPlan({ 下料编号: 'CUT-A', 板厚规格: '10mm', 零件数量: 30, 排料方式: '自动套料', 材料利用率: 90 })
check('利用率达标判可排料', result.ok && result.verdict === '可排料')
result = submitPlan({ 下料编号: 'CUT-B', 板厚规格: '10mm', 零件数量: 20, 排料方式: '手工排料', 材料利用率: 82 })
check('利用率落在复核带宽判待复核', result.ok && result.verdict === '待复核')
result = submitPlan({ 下料编号: 'CUT-C', 板厚规格: '10mm', 零件数量: 10, 排料方式: '手工排料', 材料利用率: 70 })
check('利用率低于复核下限判退回', result.ok && result.verdict === '退回')
check('退回单落库但不占产能', remainingCapacity() === 95 - 30 - 20)
check('退回单不扣可领用量', quotaOf('10mm').可领 === 500 - 30 - 20)

// ---------- 3. 冲突以设备产能为准，超上限不落库 ----------
console.log('场景3：产能冲突优先，超上限不落库')
resetNestingState() // 剩余产能 95
result = submitPlan({ 下料编号: 'CUT-D', 板厚规格: '10mm', 零件数量: 96, 排料方式: '自动套料', 材料利用率: 99 })
check('利用率再高也敌不过产能：判退回', result.verdict === '退回')
check('超上限的排料单存不进去', !result.ok && !planByCode('CUT-D') && result.message.includes('不予落库'))
check('超上限未占产能、未扣材料', remainingCapacity() === 95 && quotaOf('10mm').可领 === 500)

// ---------- 4. 联动扣减：准入与其它入口共用一本账 ----------
console.log('场景4：钢材可领用量联动扣减')
resetNestingState()
result = submitPlan({ 下料编号: 'CUT-E', 板厚规格: '20mm', 零件数量: 50, 排料方式: '自动套料', 材料利用率: 90 })
check('准入成功', result.ok)
check('准入口径扣减可领用量', quotaOf('20mm').可领 === 200 - 50)
result = registerRequisition({ 规格: '20mm', 数量: 100, 来源: '钢材管理-领用登记', 关联单号: 'WO-1' })
check('其它入口领用成功', result.ok)
check('其它入口一并扣减同一池子', quotaOf('20mm').可领 === 50)
result = registerRequisition({ 规格: '20mm', 数量: 60, 来源: '钢材管理-领用登记', 关联单号: 'WO-2' })
check('超额领用被拒绝', !result.ok && result.message.includes('可领用量不足'))
result = submitPlan({ 下料编号: 'CUT-F', 板厚规格: '20mm', 零件数量: 60, 排料方式: '自动套料', 材料利用率: 90 })
check('可领量不足时排料单不予落库', !result.ok && !planByCode('CUT-F'))

// ---------- 5. 重复抢排只记一次 ----------
console.log('场景5：重复抢排只记一次')
resetNestingState()
const first = submitPlan({ 下料编号: 'CUT-G', 板厚规格: '12mm', 零件数量: 40, 排料方式: '自动套料', 材料利用率: 90 })
const second = submitPlan({ 下料编号: 'CUT-G', 板厚规格: '12mm', 零件数量: 40, 排料方式: '自动套料', 材料利用率: 90 })
check('首次受理', first.ok && !first.duplicated)
check('重复提交返回已有判定', second.ok && second.duplicated && second.verdict === '可排料')
check('只落库一张单', listPlans().filter((p) => p.下料编号 === 'CUT-G').length === 1)
check('只扣一次可领用量', quotaOf('12mm').可领 === 400 - 60 - 40)
check('只占一次产能', remainingCapacity() === 200 - 60 - 45 - 40)

// ---------- 6. 并发抢排：只让先锁定的落库 ----------
console.log('场景6：并发抢排锁')
resetNestingState()
acquireNestingLock('token-A')
result = submitPlan({ 下料编号: 'CUT-H', 板厚规格: '10mm', 零件数量: 10, 排料方式: '自动套料', 材料利用率: 90 })
check('他人持锁时提交被拒绝', !result.ok && result.message.includes('并发抢排'))
check('被拒绝的提交未落库', !planByCode('CUT-H'))
releaseNestingLock('token-A')
result = submitPlan({ 下料编号: 'CUT-H', 板厚规格: '10mm', 零件数量: 10, 排料方式: '自动套料', 材料利用率: 90 })
check('锁释放后同一提交可落库', result.ok && !!planByCode('CUT-H'))
check('正常提交后锁已释放', inspectNestingLock() === null)

// ---------- 7. 标准改版：未排完的按新标准重判 ----------
console.log('场景7：排料标准改版重判')
resetNestingState()
let std = changeStandard({ capacityLimit: 200, utilizationFloor: 80, reviewBand: 5, operator: '测试' })
check('改版生成新版本', std.ok && std.version === 2 && currentStandard().version === 2)
check('利用率下限放宽后待复核转可排料', planByCode('CUT-2026-0002').verdict === '可排料')
check('重判清单记录了这次变化', std.rejudged.some((c) => c.下料编号 === 'CUT-2026-0002' && c.from === '待复核' && c.to === '可排料'))
check('判定版本号同步更新', planByCode('CUT-2026-0002').standardVersion === 2)

std = changeStandard({ capacityLimit: 80, utilizationFloor: 85, reviewBand: 5, operator: '测试' })
check('产能上限收紧到 80', std.ok && currentStandard().capacityLimit === 80)
check('先创建的单仍占住产能', planByCode('CUT-2026-0001').verdict === '可排料')
check('产能不够的单被重判退回', planByCode('CUT-2026-0002').verdict === '退回')
check('重判退回后释放材料占用', quotaOf('16mm').可领 === 300)
check('剩余产能按新占用重算', remainingCapacity() === 80 - 60)

// ---------- 8. 已排完的不参与重判 ----------
console.log('场景8：已排完单不受改版影响')
resetNestingState()
const finished = markPlanFinished(1) // CUT-2026-0001，60 件
check('标记排完成功', finished.ok)
check('排完释放产能', remainingCapacity() === 200 - 45)
std = changeStandard({ capacityLimit: 30, utilizationFloor: 95, reviewBand: 5, operator: '测试' })
check('已排完单判定不变', planByCode('CUT-2026-0001').verdict === '可排料')
check('已排完单仍停留在旧标准版本', planByCode('CUT-2026-0001').standardVersion === 1)
check('未排完单按新标准重判（83% < 95%-5%）', planByCode('CUT-2026-0002').verdict === '退回')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
