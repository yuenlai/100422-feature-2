// 准入规则验证脚本：tsc 编译成 CJS 后用 node 跑，不走浏览器。
// 跑法（在 frontend/ 下）：
//   ./node_modules/.bin/tsc -p scripts/tsconfig.verify.json
//   node -r ./scripts/alias-hook.cjs ./node_modules/.cache/verify/scripts/verify-nesting.js
import {
  currentNestingStandard,
  deductMaterialStock,
  submitNesting,
  updateNestingStandard,
} from '../src/api/nesting-service'
import { listRows } from '../src/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`, detail ?? '')
  }
}

const base = {
  下料编号: 'CUTT-9001',
  板厚规格: '12mm',
  零件数量: 10,
  排料方式: '数控套料',
  材料利用率: 90,
  下料设备: '数控切割机-B',
  关联分段: 'BLOC-9001',
  操作人员: '验证员',
}

// 1. 四项填齐 + 双达标 → 可排料，落库，钢材可领用量扣减
const before = listRows('material').find((r) => r['批次编号'] === 'MATE-0002')
const r1 = submitNesting(base)
check('可排料落库', r1.ok && r1.verdict === '可排料', r1)
const saved = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-9001')
check('落库状态为待排料', saved?.status === '待排料' && saved?.['准入结论'] === '可排料', saved)
const after = listRows('material').find((r) => r['批次编号'] === 'MATE-0002')
check(
  '钢材可领用量一并扣减',
  Number(before?.['可领用量']) - Number(after?.['可领用量']) === 10 &&
    String(after?.['领用记录']).includes('CUTT-9001 领用 10 件'),
  { before: before?.['可领用量'], after: after?.['可领用量'], log: after?.['领用记录'] },
)

// 2. 重复抢排只记一次
const r2 = submitNesting(base)
const count = listRows('cutting').filter((r) => r['下料编号'] === 'CUTT-9001').length
check('重复抢排只记一次', r2.ok && count === 1, { r2, count })

// 3. 缺必填项 → 不受理
const r3 = submitNesting({ ...base, 下料编号: 'CUTT-9002', 板厚规格: '' })
check('四项未填齐不受理', !r3.ok && !listRows('cutting').some((r) => r['下料编号'] === 'CUTT-9002'), r3)

// 4. 超设备产能上限 → 退回且存不进去（默认上限 100，切割机-A 已占 10+20=30，再排 80 → 110）
const r4 = submitNesting({ ...base, 下料编号: 'CUTT-9003', 下料设备: '数控切割机-A', 零件数量: 80 })
check(
  '超产能上限退回不落库',
  !r4.ok && r4.verdict === '退回' && !listRows('cutting').some((r) => r['下料编号'] === 'CUTT-9003'),
  r4,
)

// 5. 产能够、利用率不够 → 待复核，落库标异常（冲突时产能优先已隐含验证：产能超了连待复核都不是）
const r5 = submitNesting({ ...base, 下料编号: 'CUTT-9004', 材料利用率: 80 })
const saved5 = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-9004')
check(
  '利用率不足待复核',
  r5.ok && r5.verdict === '待复核' && saved5?.['准入结论'] === '待复核' && saved5?.abnormal === true,
  { r5, saved5 },
)

// 6. 标准换过以后，没排完的按新标准重判（利用率下限提到 95：CUTT-9001 利用率 90 → 待复核）
const u1 = updateNestingStandard(100, 95)
const rej1 = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-9001')
check(
  '标准变更后未排完重判',
  u1.ok && u1.standard?.version === 2 && rej1?.['准入结论'] === '待复核' && rej1?.['标准版本'] === 2,
  { u1, rej1 },
)
const done = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-0003')
check('已下料的不参与重判', done?.['标准版本'] === 1 && done?.['准入结论'] === '可排料', done)

// 7. 产能上限收紧 → 未排完里超出的转退回、标异常（A 设备：待排料 10 + 排料中 20 = 30 > 上限 25）
const u2 = updateNestingStandard(25, 85)
const rej2a = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-0001')
const rej2b = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-0002')
check(
  '收紧产能后重判出退回',
  u2.ok && rej2a?.['准入结论'] === '可排料' && rej2b?.['准入结论'] === '退回' && rej2b?.abnormal === true,
  { rej2a, rej2b, rejudge: u2.rejudge },
)

// 8. 标准没变化不升版本（u2 已升到 v3，重复提交相同标准应保持 v3）
const u3 = updateNestingStandard(25, 85)
check('标准无变化不升版本', !u3.ok && currentNestingStandard().version === 3, u3)

// 9. 扣减只认已检验批次，缺口如实报（10mm 只有待检验批次 100，不可领）
const d = deductMaterialStock('10mm', 5, 'CUTT-9005')
check('待检验批次不参与扣减', d.deducted === 0 && d.shortage === 5, d)

// 10. 恢复默认标准，重判能捞回可排料
const u4 = updateNestingStandard(100, 85)
const back = listRows('cutting').find((r) => r['下料编号'] === 'CUTT-0001')
check('标准放宽后重判恢复', u4.ok && back?.['准入结论'] === '可排料' && back?.abnormal === false, back)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
