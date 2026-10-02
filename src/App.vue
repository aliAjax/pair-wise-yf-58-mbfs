<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore, type EvalResult } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const fingerprint = computed(() => store.currentFingerprint);
const approvalsValid = computed(() => store.approvalsValid);
const createOpen = ref(false);
const evaluation = ref<EvalResult | null>(null);
const scheduleDraft = ref('');
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, ruleVersion: 1, status: 'draft' });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '', state: 'idle', approvals: [], snapshot: null });
  store.select(id); store.logAudit('创建开关', `${values.key} 草稿，规则版本 v1`); createOpen.value = false; resetForm();
});
function simulate() { evaluation.value = store.evaluate(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : status === 'scheduled' ? 'purple' : 'gold'; }
function auditColor(action: string) { if (action.includes('停止') || action.includes('回滚')) return 'red'; if (action.includes('过期') || action.includes('补发') || action.includes('拦截')) return 'orange'; return 'blue'; }
function planOf(flagId: string) { return store.plans.find((item) => item.flagId === flagId); }
function fmtTime(value?: string | null) { return value ? value.replace('T', ' ') : '-'; }
const canApprove = computed(() => !!active.value && ['draft', 'stopped', 'rolled-back'].includes(active.value.status));
const canPublish = computed(() => !!active.value && ['approved', 'stopped', 'rolled-back'].includes(active.value.status) && approvalsValid.value);
watch(active, () => { scheduleDraft.value = plan.value?.scheduledAt ?? ''; evaluation.value = null; }, { immediate: true });

let timer = 0;
onMounted(() => { store.checkScheduled(online.value); timer = window.setInterval(() => store.checkScheduled(online.value), 15000); });
onUnmounted(() => window.clearInterval(timer));
watch(online, (value) => store.checkScheduled(value));
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布；到点的定时生效会记为过期待补发。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag><a-tag v-if="planOf(item.id)?.state === 'overdue'" color="orange">待补发</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}% · 规则 v{{ item.ruleVersion }}</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="条件与放量模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form>
            <template v-if="evaluation">
              <div class="steps mt"><div v-for="step in evaluation.steps" :key="step.key" class="step"><span :class="['step-icon', step.pass ? 'ok' : 'no']">{{ step.pass ? '✓' : '✗' }}</span><b>{{ step.label }}</b><span class="step-detail">{{ step.detail }}</span></div><div v-if="evaluation.bucket !== null" class="step"><span :class="['step-icon', evaluation.bucket < evaluation.rollout ? 'ok' : 'no']">◈</span><b>灰度桶</b><span class="step-detail">桶号 {{ evaluation.bucket }}，放量线 {{ evaluation.rollout }}%</span></div></div>
              <a-alert class="mt" :type="evaluation.hit ? 'success' : 'info'" show-icon :message="evaluation.hit ? '命中新功能' : '未命中'" :description="evaluation.reason" />
            </template>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 4 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="规则版本">v{{ active.ruleVersion }}</a-descriptions-item><a-descriptions-item label="内容指纹"><code>{{ fingerprint }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item></a-descriptions>
              <a-divider>条件规则（依次判断：用户标识 → 地区 → 登录要求 → 版本）</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>
              <div class="hint">放宽条件不会踢出已命中用户，只有新增/收紧条件才会拦下条件外的人；任何规则修改都会使内容指纹失效，需退回草稿重新审批。</div>
              <a-divider>逐步放量（独立于条件审批）</a-divider><a-slider :value="active.rollout" :min="0" :max="100" :step="5" @change="(value: number) => store.setRollout(value)" /><div class="rollout-label">{{ active.rollout }}% 用户可命中</div>
              <div class="hint">灰度桶按「开关 Key + 用户标识」稳定计算，调整放量或放宽条件不会改变同一用户的桶号。</div>
              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" v-model:value="scheduleDraft" style="width: 240px" /><a-button :disabled="!canPublish || !scheduleDraft" @click="store.schedule(scheduleDraft)">保存定时</a-button></a-space>
              <a-alert v-if="plan.state === 'overdue'" class="mt" type="error" show-icon message="已过计划时间，待补发" :description="`计划 ${fmtTime(plan.scheduledAt)} 生效，因离线或重启错过。值班人确认后按规则版本 v${active.ruleVersion}（指纹 ${fingerprint}）补发。`" />
              <a-space v-if="plan.state === 'overdue'" class="mt"><a-button type="primary" danger :disabled="!online" @click="store.confirmReissue()">值班人确认补发</a-button><span v-if="!online" class="hint">离线中，恢复网络后才能补发</span></a-space>
              <a-alert v-else-if="plan.state === 'scheduled'" class="mt" type="info" show-icon :message="`将于 ${fmtTime(plan.scheduledAt)} 生效`" description="到点自动生效；若届时离线或应用未打开，将记为过期待补发，需值班人确认。" />
              <a-alert v-else-if="plan.state === 'effective' && plan.snapshot" class="mt" type="success" show-icon :message="`已于 ${plan.snapshot.effectiveAt} 生效`" :description="`采用规则版本 v${plan.snapshot.version}（指纹 ${plan.snapshot.fingerprint}）`" />
              <a-divider>最近一次生效的规则快照</a-divider>
              <a-descriptions v-if="plan.snapshot" bordered size="small" :column="{ xs: 1, md: 2 }"><a-descriptions-item label="规则版本">v{{ plan.snapshot.version }}</a-descriptions-item><a-descriptions-item label="指纹"><code>{{ plan.snapshot.fingerprint }}</code></a-descriptions-item><a-descriptions-item label="生效时间">{{ plan.snapshot.effectiveAt }}</a-descriptions-item><a-descriptions-item label="放量">{{ plan.snapshot.rollout }}%</a-descriptions-item><a-descriptions-item label="规则内容" :span="2"><code>{{ plan.snapshot.rules.region }} · {{ plan.snapshot.rules.appVersion }} · {{ plan.snapshot.rules.authenticated ? '需登录' : '免登录' }}</code></a-descriptions-item></a-descriptions>
              <a-empty v-else description="尚未生效过" />
              <a-divider>审批与发布</a-divider>
              <a-alert v-if="plan.approvals.length && !approvalsValid" type="warning" show-icon class="mb" message="内容指纹已变更" description="规则在审批后被修改，旧批准不能继续放量，需退回草稿重新审批。" />
              <a-space><a-button :disabled="!canApprove || plan.approvals.some(item => item.role === '产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button><a-button :disabled="!canApprove || plan.approvals.some(item => item.role === '研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button><a-button type="primary" :disabled="!canPublish" @click="store.startRollout">开始灰度发布</a-button></a-space>
              <div class="mt"><a-tag v-for="item in plan.approvals" :key="item.role" :color="item.fingerprint === fingerprint ? 'green' : 'red'">{{ item.role }} · 指纹 {{ item.fingerprint }} · {{ item.at }}</a-tag><span v-if="!plan.approvals.length" class="hint">待审批：产品、研发需确认同一内容指纹</span></div>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="auditColor(item.action)"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
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
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.hint { color: #8a8f99; font-size: 12px; margin-top: 6px; }
.steps { border: 1px solid #eef0f4; border-radius: 8px; padding: 8px 12px; background: #fafbff; }
.step { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 13px; }
.step-icon { width: 18px; text-align: center; font-weight: 700; }
.step-icon.ok { color: #16a34a; }.step-icon.no { color: #dc2626; }
.step-detail { color: #6b7280; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
