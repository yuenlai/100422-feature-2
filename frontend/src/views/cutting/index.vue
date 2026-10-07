<template>
  <section class="page" data-module="cutting">
    <header class="page-head">
      <div>
        <h2>钢板下料管理</h2>
        <p class="page-desc">维护下料任务，围绕下料编号、关联分段、板厚规格、零件数量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记下料任务</button>
        <button class="btn" type="button" @click="exportRows">导出钢板下料清单</button>
      </div>
    </header>

    <section class="panel" data-panel="nesting-gate">
      <h3 class="panel-title">排料准入门</h3>
      <p class="panel-sub">
        当前标准 v{{ standard.version }}：设备产能上限 {{ standard.capacityLimit }} 件/班、
        材料利用率下限 {{ standard.utilizationFloor }}%（复核带宽 {{ standard.reviewBand }}%）、
        剩余产能 {{ remaining }} 件。判定冲突时以设备产能为准，超上限的排料单不落库。
      </p>

      <form class="filter-bar" @submit.prevent="submitGate">
        <label class="filter-item">
          <span>下料编号 *</span>
          <input v-model="gateForm.下料编号" placeholder="如 CUT-2026-0003" />
        </label>
        <label class="filter-item">
          <span>板厚规格 *</span>
          <select v-model="gateForm.板厚规格">
            <option value="" disabled>请选择规格</option>
            <option v-for="quota in quotas" :key="quota.规格" :value="quota.规格">
              {{ quota.规格 }}（可领 {{ quota.可领 }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>零件数量 *</span>
          <input v-model.number="gateForm.零件数量" type="number" min="1" placeholder="件" />
        </label>
        <label class="filter-item">
          <span>排料方式 *</span>
          <select v-model="gateForm.排料方式">
            <option value="" disabled>请选择方式</option>
            <option v-for="mode in nestingModes" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>预计材料利用率（%）*</span>
          <input v-model.number="gateForm.材料利用率" type="number" min="1" max="100" placeholder="如 88" />
        </label>
        <button class="btn primary" type="submit">提交排料准入</button>
      </form>
      <p v-if="gateMessage" class="gate-message" :class="gateOk ? 'ok-text' : 'error-text'">
        {{ gateMessage }}
      </p>

      <details class="standard-editor">
        <summary>调整排料标准（未排完的排料单将按新标准重判）</summary>
        <form class="filter-bar" @submit.prevent="submitStandard">
          <label class="filter-item">
            <span>设备产能上限（件/班）</span>
            <input v-model.number="standardForm.capacityLimit" type="number" min="1" />
          </label>
          <label class="filter-item">
            <span>材料利用率下限（%）</span>
            <input v-model.number="standardForm.utilizationFloor" type="number" min="1" max="100" />
          </label>
          <label class="filter-item">
            <span>复核带宽（百分点）</span>
            <input v-model.number="standardForm.reviewBand" type="number" min="0" max="100" />
          </label>
          <button class="btn" type="submit">切换标准并重判</button>
        </form>
        <p v-if="standardMessage" class="gate-message ok-text">{{ standardMessage }}</p>
        <p v-for="change in rejudged" :key="change.下料编号" class="rejudge-item">
          {{ change.下料编号 }}：{{ change.from }} → {{ change.to }}
        </p>
      </details>

      <table class="data-table">
        <thead>
          <tr>
            <th>下料编号</th>
            <th>板厚规格</th>
            <th>零件数量</th>
            <th>排料方式</th>
            <th>材料利用率</th>
            <th>准入判定</th>
            <th>判定说明</th>
            <th>标准版本</th>
            <th>进度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="plan in plans" :key="plan.id">
            <td>{{ plan.下料编号 }}</td>
            <td>{{ plan.板厚规格 }}</td>
            <td>{{ plan.零件数量 }}</td>
            <td>{{ plan.排料方式 }}</td>
            <td>{{ plan.材料利用率 }}%</td>
            <td><span class="verdict" :class="verdictClass(plan.verdict)">{{ plan.verdict }}</span></td>
            <td>{{ plan.reason }}</td>
            <td>v{{ plan.standardVersion }}</td>
            <td>{{ plan.finished ? '已排完' : '未排完' }}</td>
            <td class="row-actions">
              <button v-if="!plan.finished" class="link" type="button" @click="finishPlan(plan.id)">
                标记排完
              </button>
            </td>
          </tr>
          <tr v-if="!plans.length">
            <td colspan="10" class="empty-state">暂无排料单，提交准入门后在此展示</td>
          </tr>
        </tbody>
      </table>

      <h4 class="panel-sub-title">钢材可领用量（与钢材管理等入口联动扣减）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>规格</th>
            <th>总量</th>
            <th>已占用</th>
            <th>可领用量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="quota in quotas" :key="quota.规格">
            <td>{{ quota.规格 }}</td>
            <td>{{ quota.总量 }}</td>
            <td>{{ quota.已占用 }}</td>
            <td>{{ quota.可领 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
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
  changeStandard,
  currentStandard,
  listPlans,
  listQuotas,
  markPlanFinished,
  remainingCapacity,
  submitPlan,
} from '@/api/nesting-service'
import type { NestingPlan, NestingStandard, Verdict } from '@/data/nesting-store'
import type { QuotaView, RejudgeChange } from '@/api/nesting-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cutting')
const columns = ["下料编号", "关联分段", "板厚规格", "零件数量", "排料方式", "下料设备", "操作人员", "下料状态"]
const actions = ["完成排料", "开始下料", "提交报验"]
const statuses = ["待排料", "排料中", "下料中", "已下料", "已报验"]
const stats = [{"label": "待下料零件", "value": 0}, {"label": "下料中零件", "value": 0}, {"label": "已报验零件", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---- 排料准入门 ----
const nestingModes = ['自动套料', '手工排料', '混合排料']
const standard = ref<NestingStandard>(currentStandard())
const remaining = ref(remainingCapacity())
const plans = ref<NestingPlan[]>([])
const quotas = ref<QuotaView[]>([])
const gateForm = ref({ 下料编号: '', 板厚规格: '', 零件数量: 0, 排料方式: '', 材料利用率: 0 })
const gateMessage = ref('')
const gateOk = ref(false)
const standardForm = ref({
  capacityLimit: standard.value.capacityLimit,
  utilizationFloor: standard.value.utilizationFloor,
  reviewBand: standard.value.reviewBand,
})
const standardMessage = ref('')
const rejudged = ref<RejudgeChange[]>([])

function verdictClass(verdict: Verdict) {
  return { ok: verdict === '可排料', review: verdict === '待复核', reject: verdict === '退回' }
}

function refreshGate() {
  standard.value = currentStandard()
  remaining.value = remainingCapacity()
  plans.value = listPlans()
  quotas.value = listQuotas()
}

function submitGate() {
  gateMessage.value = ''
  const result = submitPlan(gateForm.value)
  gateOk.value = result.ok
  gateMessage.value = result.message
  if (result.ok && !result.duplicated) {
    gateForm.value = { 下料编号: '', 板厚规格: '', 零件数量: 0, 排料方式: '', 材料利用率: 0 }
  }
  refreshGate()
}

function submitStandard() {
  standardMessage.value = ''
  rejudged.value = []
  const result = changeStandard({ ...standardForm.value, operator: '值班管理员' })
  if (!result.ok) {
    standardMessage.value = result.message
    return
  }
  standardMessage.value = result.message
  rejudged.value = result.rejudged
  standardForm.value = {
    capacityLimit: currentStandard().capacityLimit,
    utilizationFloor: currentStandard().utilizationFloor,
    reviewBand: currentStandard().reviewBand,
  }
  refreshGate()
}

function finishPlan(id: number) {
  const result = markPlanFinished(id)
  gateOk.value = result.ok
  gateMessage.value = result.message
  refreshGate()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '下料任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '钢板下料列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshGate()
})
</script>
