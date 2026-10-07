<template>
  <section class="page" data-module="cutting">
    <header class="page-head">
      <div>
        <h2>钢板下料管理</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记下料任务</button>
        <button class="btn" type="button" @click="toggleStandard">调整排料标准</button>
        <button class="btn" type="button" @click="exportRows">导出钢板下料清单</button>
      </div>
    </header>

    <p class="standard-line">
      现行排料标准 v{{ standard.version }}：设备产能上限 {{ standard.capacityLimit }} 件/班 ·
      材料利用率下限 {{ standard.utilizationFloor }}% · {{ standard.updatedAt }} 起执行
    </p>

    <form v-if="showStandard" class="panel" @submit.prevent="applyStandard">
      <h3>调整排料标准</h3>
      <p class="panel-tip">标准换过以后，没排完（待排料 / 排料中）的排料单会按新标准重判，已下料、已报验的不动。</p>
      <div class="form-grid">
        <label>
          设备产能上限（件/班）
          <input v-model.number="standardForm.capacityLimit" type="number" min="1" required />
        </label>
        <label>
          材料利用率下限（%）
          <input v-model.number="standardForm.utilizationFloor" type="number" min="0" max="100" step="0.1" required />
        </label>
      </div>
      <button class="btn primary" type="submit">保存标准并重判</button>
    </form>

    <form v-if="showCreate" class="panel" @submit.prevent="submitAdmission">
      <h3>排料准入登记</h3>
      <p class="panel-tip">
        下料编号、板厚规格、零件数量、排料方式填齐后提交，按设备产能与材料利用率下限判定可排料、待复核还是退回；
        冲突时以设备产能为准，超上限的排料单存不进去。落库后钢材管理的可领用量会一并扣减。
      </p>
      <div class="form-grid">
        <label>
          下料编号 *
          <input v-model.trim="form.下料编号" required placeholder="如 CUTT-0004" />
        </label>
        <label>
          关联分段
          <input v-model.trim="form.关联分段" placeholder="如 BLOC-0004" />
        </label>
        <label>
          板厚规格 *
          <input v-model.trim="form.板厚规格" list="spec-options" required placeholder="如 12mm" />
        </label>
        <label>
          零件数量 *
          <input v-model.number="form.零件数量" type="number" min="1" required />
        </label>
        <label>
          排料方式 *
          <select v-model="form.排料方式" required>
            <option v-for="mode in nestingModes" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>
        <label>
          材料利用率（%）*
          <input v-model.number="form.材料利用率" type="number" min="0" max="100" step="0.1" required />
        </label>
        <label>
          下料设备 *
          <input v-model.trim="form.下料设备" list="device-options" required placeholder="如 数控切割机-A" />
        </label>
        <label>
          操作人员
          <input v-model.trim="form.操作人员" />
        </label>
      </div>
      <datalist id="spec-options">
        <option v-for="spec in specOptions" :key="spec" :value="spec" />
      </datalist>
      <datalist id="device-options">
        <option v-for="device in deviceOptions" :key="device" :value="device" />
      </datalist>
      <button class="btn primary" type="submit">提交准入判定</button>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p v-if="errorMessage" class="message-line error-text">{{ errorMessage }}</p>
    <p v-if="noticeMessage" class="message-line notice-text">{{ noticeMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '准入结论'" class="verdict" :class="verdictClass(row)">
              {{ row[column] ?? '—' }}
            </span>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无钢板下料数据，可先登记下料任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条钢板下料记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  currentNestingStandard,
  submitNesting,
  updateNestingStandard,
} from '@/api/nesting-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cutting')
const columns = ["下料编号", "关联分段", "板厚规格", "零件数量", "排料方式", "下料设备", "操作人员", "材料利用率", "准入结论", "下料状态"]
const actions = ["完成排料", "开始下料", "提交报验"]
const statuses = ["待排料", "排料中", "下料中", "已下料", "已报验"]
const nestingModes = ["数控套料", "手工放样", "光电跟踪", "等离子套料"]
const defaultDevices = ["数控切割机-A", "数控切割机-B", "等离子切割机-C"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const standard = ref(currentNestingStandard())
const showCreate = ref(false)
const showStandard = ref(false)
const standardForm = ref({ capacityLimit: 0, utilizationFloor: 0 })
const form = ref({
  下料编号: '',
  关联分段: '',
  板厚规格: '',
  零件数量: 1,
  排料方式: nestingModes[0],
  材料利用率: 90,
  下料设备: defaultDevices[0],
  操作人员: '',
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待下料零件', value: sumParts(['待排料', '排料中']) },
  { label: '下料中零件', value: sumParts(['下料中']) },
  { label: '已报验零件', value: sumParts(['已报验']) },
])

// 板厚规格选项来自钢材管理在册的规格，填新规格也允许（datalist 不限制输入）
const specOptions = computed(() => {
  const specs = listEntries('material').items.map((row) => String(row['规格尺寸'] ?? ''))
  return [...new Set(specs.filter((spec) => spec !== ''))]
})

const deviceOptions = computed(() => {
  const used = rows.value.map((row) => String(row['下料设备'] ?? ''))
  return [...new Set([...defaultDevices, ...used].filter((device) => device !== ''))]
})

function sumParts(targetStatuses: string[]): number {
  return rows.value
    .filter((row) => targetStatuses.includes(String(row.status)))
    .reduce((sum, row) => sum + (Number(row['零件数量']) || 0), 0)
}

function verdictClass(row: EntryRow): string {
  const verdict = String(row['准入结论'] ?? '')
  if (verdict === '可排料') return 'ok'
  if (verdict === '待复核') return 'review'
  if (verdict === '退回') return 'reject'
  return ''
}

function toggleCreate() {
  showCreate.value = !showCreate.value
  showStandard.value = false
}

function toggleStandard() {
  showStandard.value = !showStandard.value
  showCreate.value = false
  if (showStandard.value) {
    standardForm.value = {
      capacityLimit: standard.value.capacityLimit,
      utilizationFloor: standard.value.utilizationFloor,
    }
  }
}

function submitAdmission() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = submitNesting({ ...form.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  // 保留设备、排料方式等，连续登记时只换编号
  form.value = { ...form.value, 下料编号: '', 关联分段: '', 操作人员: '' }
  showCreate.value = false
  reload()
}

function applyStandard() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = updateNestingStandard(
    standardForm.value.capacityLimit,
    standardForm.value.utilizationFloor,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  showStandard.value = false
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    standard.value = currentNestingStandard()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '钢板下料列表读取失败'
  }
}

onMounted(reload)
</script>
