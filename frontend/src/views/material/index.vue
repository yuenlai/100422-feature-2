<template>
  <section class="page" data-module="material">
    <header class="page-head">
      <div>
        <h2>钢材管理管理</h2>
        <p class="page-desc">维护钢材批次，围绕批次编号、钢材牌号、规格尺寸、入库数量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记钢材批次</button>
        <button class="btn" type="button" @click="exportRows">导出钢材管理清单</button>
      </div>
    </header>

    <section class="panel" data-panel="steel-quota">
      <h3 class="panel-title">钢材可领用量（与钢板下料排料准入共用同一本账）</h3>
      <p class="panel-sub">排料准入、本页领用登记等入口都会一并扣减可领用量。</p>
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

      <form class="filter-bar quota-form" @submit.prevent="submitRequisition">
        <label class="filter-item">
          <span>领用规格</span>
          <select v-model="requisitionForm.规格">
            <option value="" disabled>请选择规格</option>
            <option v-for="quota in quotas" :key="quota.规格" :value="quota.规格">
              {{ quota.规格 }}（可领 {{ quota.可领 }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>领用数量</span>
          <input v-model.number="requisitionForm.数量" type="number" min="1" placeholder="件" />
        </label>
        <label class="filter-item">
          <span>关联单号</span>
          <input v-model="requisitionForm.关联单号" placeholder="如工单/批次号" />
        </label>
        <button class="btn" type="submit">登记领用</button>
      </form>
      <p v-if="requisitionMessage" class="gate-message" :class="requisitionOk ? 'ok-text' : 'error-text'">
        {{ requisitionMessage }}
      </p>

      <h4 class="panel-sub-title">领用流水</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>来源入口</th>
            <th>规格</th>
            <th>数量</th>
            <th>关联单号</th>
            <th>登记时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in requisitions" :key="item.id">
            <td>{{ item.来源 }}</td>
            <td>{{ item.规格 }}</td>
            <td>{{ item.数量 }}</td>
            <td>{{ item.关联单号 }}</td>
            <td>{{ formatTime(item.createdAt) }}</td>
          </tr>
          <tr v-if="!requisitions.length">
            <td colspan="5" class="empty-state">暂无领用记录</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无钢材管理数据，可先登记钢材批次</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条钢材管理记录</span>
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
import { listQuotas, listRequisitions, registerRequisition } from '@/api/nesting-service'
import type { QuotaView } from '@/api/nesting-service'
import type { SteelRequisition } from '@/data/nesting-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('material')
const columns = ["批次编号", "钢材牌号", "规格尺寸", "入库数量", "检验证书", "存放堆场", "领用记录", "批次状态"]
const actions = ["完成检验", "发放钢材", "办理退库"]
const statuses = ["待检验", "已入库", "已发放", "已用完", "待退库"]
const stats = [{"label": "在库钢材", "value": 0}, {"label": "已发放钢材", "value": 0}, {"label": "待检验批次", "value": 0}]

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

// ---- 钢材可领用量：与排料准入联动的其它入口 ----
const quotas = ref<QuotaView[]>([])
const requisitions = ref<SteelRequisition[]>([])
const requisitionForm = ref({ 规格: '', 数量: 0, 关联单号: '' })
const requisitionMessage = ref('')
const requisitionOk = ref(false)

function refreshQuota() {
  quotas.value = listQuotas()
  requisitions.value = listRequisitions()
}

function submitRequisition() {
  requisitionMessage.value = ''
  const result = registerRequisition({ ...requisitionForm.value, 来源: '钢材管理-领用登记' })
  requisitionOk.value = result.ok
  requisitionMessage.value = result.message
  if (result.ok) {
    requisitionForm.value = { 规格: '', 数量: 0, 关联单号: '' }
  }
  refreshQuota()
}

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '钢材批次登记入口尚未接入审批流'
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
    errorMessage.value = error instanceof Error ? error.message : '钢材管理列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshQuota()
})
</script>
