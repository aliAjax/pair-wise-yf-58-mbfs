<script setup lang="ts">
import axios from 'axios';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { fingerprintOf, useFlagStore } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string; checks: { rule: string; pass: boolean; detail: string }[]; bucket: number | null; sticky: boolean } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft', stickyUsers: [] });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-03T10:00', approvals: [], version: 1, approvedFingerprint: null, lastSnapshot: null, makeup: null, armed: false });
  store.select(id); store.logAudit('创建开关', `${values.key} 草稿版本 1`); createOpen.value = false; resetForm();
});
function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { store.checkScheduled(online.value); timer = setInterval(() => store.checkScheduled(online.value), 20000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
watch(online, (value) => { if (value) store.checkScheduled(true); });
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器；定时生效在断网期间到点不会生效，恢复后若已过点记为过期待补发，值班人确认后补发。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}%</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID（稳定灰度桶依据）"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon>
              <template #message>{{ simulation.hit ? '命中新功能' : '未命中' }}<a-tag v-if="simulation.sticky" color="purple" class="ml">放量粘性</a-tag></template>
              <template #description>
                <ul class="check-list">
                  <li v-for="check in simulation.checks" :key="check.rule">
                    <a-tag :color="check.pass ? 'green' : 'red'">{{ check.pass ? '通过' : '拦下' }} · {{ check.rule }}</a-tag>
                    <span>{{ check.detail }}</span>
                  </li>
                </ul>
              </template>
            </a-alert>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item><a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item><a-descriptions-item label="规则版本">v{{ plan.version }}</a-descriptions-item><a-descriptions-item label="内容指纹"><code>{{ plan.approvedFingerprint || '未审批' }}</code></a-descriptions-item><a-descriptions-item label="已命中用户">{{ active.stickyUsers.length }} 人（放量粘性）</a-descriptions-item></a-descriptions>
              <a-alert v-if="plan.makeup?.status === 'pending'" class="mt" type="warning" show-icon message="定时生效已过点，待值班人补发" :description="`计划时间 ${plan.makeup.plannedAt} 因断网或重开未生效，确认后立即补发并记录实际补发时间与规则版本。`"><template #action><a-button type="primary" size="small" @click="store.confirmMakeup">值班人确认补发</a-button></template></a-alert>
              <a-descriptions v-if="plan.lastSnapshot" bordered size="small" class="mt" :column="{ xs: 1, md: 2 }"><a-descriptions-item label="最近生效快照">v{{ plan.lastSnapshot.version }} · {{ plan.lastSnapshot.effectiveAt }}</a-descriptions-item><a-descriptions-item label="快照指纹"><code>{{ plan.lastSnapshot.fingerprint }}</code> · 放量 {{ plan.lastSnapshot.rollout }}%{{ plan.makeup?.status === 'confirmed' ? ` · 已于 ${plan.makeup.makeupAt} 补发` : '' }}</a-descriptions-item></a-descriptions>
              <a-divider>规则组合</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>
              <div class="fingerprint">当前规则指纹：<code>{{ fingerprintOf(active.rules) }}</code><span class="hint">规则修改后已批准的指纹立即失效，需重新审批</span></div>
              <a-divider>逐步放量</a-divider><a-slider :value="active.rollout" :min="0" :max="100" :step="5" @change="(value: number) => store.setRollout(value)" /><div class="rollout-label">{{ active.rollout }}% 用户可命中</div>
              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" /><a-button @click="store.schedule(plan.scheduledAt)">保存定时</a-button><a-tag v-if="active.status === 'scheduled'" :color="plan.armed ? 'blue' : 'orange'">{{ plan.armed ? '等待到点生效' : '重开后待巡检' }}</a-tag></a-space>
              <a-divider>审批与发布</a-divider><a-space><a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button><a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button><a-button type="primary" :disabled="active.status !== 'approved'" @click="store.startRollout">开始灰度发布</a-button></a-space>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.ml { margin-left: 8px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }.check-list { list-style: none; margin: 8px 0 0; padding: 0; }.check-list li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }.fingerprint { margin: -6px 0 14px; font-size: 12px; color: #6b7280; }.fingerprint .hint { margin-left: 10px; }.fingerprint code { color: #4338ca; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
