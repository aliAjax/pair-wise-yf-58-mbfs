import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type PlanState = 'idle' | 'scheduled' | 'overdue' | 'effective';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; ruleVersion: number; status: FlagStatus; }
export interface Approval { role: string; fingerprint: string; at: string; }
export interface RuleSnapshot { version: number; rules: RuleSet; rollout: number; fingerprint: string; effectiveAt: string; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; state: PlanState; approvals: Approval[]; snapshot: RuleSnapshot | null; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }
export interface ConditionStep { key: string; label: string; pass: boolean; detail: string; }
export interface EvalUser { id: string; region: string; appVersion: string; authenticated: boolean; }
export interface EvalResult { hit: boolean; blockedBy: string | null; steps: ConditionStep[]; bucket: number | null; rollout: number; enabled: boolean; reason: string; }

interface State { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; }

const STORAGE_KEY = 'yf58-flag-state-v2';
// 应用本次启动时间：启动前就已过点的定时一律记为「过期待补发」，不自动补生效
const bootedAt = Date.now();

// 内容指纹只覆盖条件规则（地区/版本/登录要求）；放量比例独立调整，不参与指纹
export function fingerprintOf(rules: RuleSet): string {
  const text = [rules.region, rules.appVersion, rules.authenticated ? '1' : '0'].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// 稳定灰度桶：只依赖 开关Key + 用户标识，规则放宽或放量调整都不会改变同一用户的桶号
export function bucketOf(flagKey: string, userId: string): number {
  const text = `${flagKey}:${userId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0) % 100;
}

export function parseVersion(text: string): number[] | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)*)$/);
  return match ? match[1].split('.').map(Number) : null;
}

export function parseVersionRule(text: string): { op: string; ver: number[] } | null {
  const match = text.trim().match(/^(>=|<=|==|=|>|<)?\s*(\d+(?:\.\d+)*)$/);
  if (!match) return null;
  return { op: match[1] || '>=', ver: match[2].split('.').map(Number) };
}

export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) { const x = a[i] ?? 0; const y = b[i] ?? 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

// 返回 null 表示规则本身无法解析（按不拦截处理）
export function versionSatisfies(userVersion: string, rule: string): boolean | null {
  const parsed = parseVersionRule(rule);
  if (!parsed) return null;
  const user = parseVersion(userVersion);
  if (!user) return false;
  const cmp = compareVersions(user, parsed.ver);
  switch (parsed.op) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    default: return cmp === 0;
  }
}

function fmt(value: string): string { return value ? value.replace('T', ' ') : '-'; }
function fmtNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 规则变更分类：放宽只扩大覆盖面，原先已命中的用户仍命中；只有新增/收紧条件才会拦下条件外的人
function classifyChange(oldR: RuleSet, newR: RuleSet): { kind: 'relax' | 'tighten'; notes: string[] } | null {
  const relaxNotes: string[] = [];
  const tightenNotes: string[] = [];
  if (oldR.region !== newR.region) {
    if (newR.region === '全部') relaxNotes.push(`地区 ${oldR.region} → 全部`);
    else tightenNotes.push(`地区 ${oldR.region} → ${newR.region}`);
  }
  if (oldR.authenticated !== newR.authenticated) {
    if (oldR.authenticated) relaxNotes.push('登录要求 需登录 → 免登录');
    else tightenNotes.push('登录要求 免登录 → 需登录');
  }
  if (oldR.appVersion !== newR.appVersion) {
    const o = parseVersionRule(oldR.appVersion);
    const n = parseVersionRule(newR.appVersion);
    if (o && n && o.op === n.op && (o.op === '>=' || o.op === '>' || o.op === '<=' || o.op === '<')) {
      const cmp = compareVersions(n.ver, o.ver);
      const relaxed = (o.op === '>=' || o.op === '>') ? cmp < 0 : cmp > 0;
      if (relaxed) relaxNotes.push(`版本门槛 ${oldR.appVersion} → ${newR.appVersion}`);
      else if (cmp !== 0) tightenNotes.push(`版本门槛 ${oldR.appVersion} → ${newR.appVersion}`);
    } else {
      tightenNotes.push(`版本规则 ${oldR.appVersion} → ${newR.appVersion}`);
    }
  }
  if (!relaxNotes.length && !tightenNotes.length) return null;
  return tightenNotes.length
    ? { kind: 'tighten', notes: [...tightenNotes, ...relaxNotes] }
    : { kind: 'relax', notes: relaxNotes };
}

// 生效时把当前规则固化成快照，发布计划始终保留最近一次生效的规则版本
function applyEffect(flag: FeatureFlag, plan: RolloutPlan, at: string): RuleSnapshot {
  const snapshot: RuleSnapshot = { version: flag.ruleVersion, rules: { ...flag.rules }, rollout: flag.rollout, fingerprint: fingerprintOf(flag.rules), effectiveAt: at };
  flag.enabled = true;
  flag.status = 'rolling';
  plan.state = 'effective';
  plan.snapshot = snapshot;
  return snapshot;
}

function buildSeed(): State {
  const f1Rules: RuleSet = { region: '上海', appVersion: '>= 8.2', authenticated: true };
  const f2Rules: RuleSet = { region: '全部', appVersion: '>= 8.0', authenticated: false };
  const fp1 = fingerprintOf(f1Rules);
  const fp2 = fingerprintOf(f2Rules);
  return {
    activeId: 'f1',
    flags: [
      { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: f1Rules, ruleVersion: 3, status: 'scheduled' },
      { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: f2Rules, ruleVersion: 2, status: 'rolling' }
    ],
    plans: [
      { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', state: 'scheduled', approvals: [
        { role: '产品负责人', fingerprint: fp1, at: '2026-09-30 17:20:11' },
        { role: '研发负责人', fingerprint: fp1, at: '2026-09-30 18:05:42' }
      ], snapshot: null },
      { id: 'p2', flagId: 'f2', scheduledAt: '', state: 'effective', approvals: [
        { role: '产品负责人', fingerprint: fp2, at: '2026-09-28 10:12:00' },
        { role: '研发负责人', fingerprint: fp2, at: '2026-09-28 10:40:00' }
      ], snapshot: { version: 2, rules: { ...f2Rules }, rollout: 35, fingerprint: fp2, effectiveAt: '2026-09-28 11:00:00' } }
    ],
    audit: [
      { id: 'a1', at: '2026-09-30 17:20:11', actor: '产品负责人', action: '审批发布', detail: `确认 checkout-v2 规则版本 v3（指纹 ${fp1}）` },
      { id: 'a2', at: '2026-09-30 18:05:42', actor: '研发负责人', action: '审批发布', detail: `确认 checkout-v2 规则版本 v3（指纹 ${fp1}），审批通过` },
      { id: 'a3', at: '2026-09-30 18:06:10', actor: '当前操作人', action: '设置定时', detail: `checkout-v2 将于 2026-10-01 10:00 生效（规则版本 v3，指纹 ${fp1}）` }
    ]
  };
}

function load(): State { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) as State : buildSeed(); }

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    currentFingerprint(): string { return this.active ? fingerprintOf(this.active.rules) : ''; },
    approvalsValid(): boolean {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || plan.approvals.length < 2) return false;
      const fp = fingerprintOf(flag.rules);
      return plan.approvals.every((item) => item.fingerprint === fp);
    }
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    logAudit(action: string, detail: string, actor = '当前操作人') {
      this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: fmtNow(), actor, action, detail });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },
    updateRule(rule: Partial<RuleSet>) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag) return;
      const oldRules = { ...flag.rules };
      const change = classifyChange(oldRules, { ...oldRules, ...rule });
      if (!change) return;
      const oldFp = fingerprintOf(oldRules);
      flag.rules = { ...oldRules, ...rule };
      flag.ruleVersion += 1;
      const newFp = fingerprintOf(flag.rules);
      // 内容指纹失效：旧批准不能继续放量，退回草稿重新审批
      const hadApproval = (plan?.approvals.length ?? 0) > 0 || flag.status === 'approved' || flag.status === 'scheduled';
      if (plan) {
        plan.approvals = [];
        if (plan.state === 'scheduled' || plan.state === 'overdue') plan.state = 'idle';
      }
      if (flag.status === 'approved' || flag.status === 'scheduled') flag.status = 'draft';
      const head = change.kind === 'relax'
        ? `规则放宽（${change.notes.join('；')}）：原先已命中的用户仍命中`
        : `新增/收紧条件（${change.notes.join('；')}）：仅拦下条件之外的用户`;
      this.logAudit('修改规则', `${head}。内容指纹 ${oldFp} → ${newFp}${hadApproval ? '，旧批准已失效，退回草稿重新审批' : ''}`);
    },
    setRollout(value: number) {
      const flag = this.active;
      if (!flag) return;
      flag.rollout = value;
      this.logAudit('调整放量', `${flag.key} → ${value}%（放量独立于条件审批，同一用户灰度桶不变）`);
    },
    approve(role: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !['draft', 'stopped', 'rolled-back'].includes(flag.status)) return;
      const fp = fingerprintOf(flag.rules);
      if (plan.approvals.some((item) => item.role === role && item.fingerprint === fp)) return;
      plan.approvals.push({ role, fingerprint: fp, at: fmtNow() });
      const done = plan.approvals.length >= 2 && plan.approvals.every((item) => item.fingerprint === fp);
      if (done) flag.status = 'approved';
      this.logAudit('审批发布', `${role} 确认 ${flag.key} 规则版本 v${flag.ruleVersion}（指纹 ${fp}）${done ? '，审批通过' : ''}`, role);
    },
    startRollout() {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const fp = fingerprintOf(flag.rules);
      const valid = plan.approvals.length >= 2 && plan.approvals.every((item) => item.fingerprint === fp);
      if (!valid) {
        if (flag.status === 'approved') {
          plan.approvals = [];
          flag.status = 'draft';
          this.logAudit('发布拦截', `${flag.key} 内容指纹 ${fp} 与批准记录不一致，旧批准不能继续放量，已退回草稿重新审批`);
        }
        return;
      }
      // 指纹未变：approved 可直接发布，停止/回滚后可直接恢复，无需重新审批
      if (!['approved', 'stopped', 'rolled-back'].includes(flag.status)) return;
      const action = flag.status === 'approved' ? '开始放量' : '恢复放量';
      const snap = applyEffect(flag, plan, fmtNow());
      this.logAudit(action, `${flag.key} 于 ${snap.effectiveAt} 生效，采用规则版本 v${snap.version}（指纹 ${snap.fingerprint}），放量 ${snap.rollout}%`);
    },
    schedule(value: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !value) return;
      const fp = fingerprintOf(flag.rules);
      const valid = plan.approvals.length >= 2 && plan.approvals.every((item) => item.fingerprint === fp);
      if (!valid || !['approved', 'stopped', 'rolled-back'].includes(flag.status)) return;
      plan.scheduledAt = value;
      plan.state = 'scheduled';
      flag.status = 'scheduled';
      this.logAudit('设置定时', `${flag.key} 将于 ${fmt(value)} 生效（规则版本 v${flag.ruleVersion}，指纹 ${fp}）`);
    },
    // 到点检查：在线且过点发生在本次运行期间 → 准点生效；离线或重启后发现已过点 → 记为过期待补发
    checkScheduled(online: boolean) {
      const now = Date.now();
      for (const flag of this.flags) {
        if (flag.status !== 'scheduled') continue;
        const plan = this.plans.find((item) => item.flagId === flag.id);
        if (!plan || plan.state !== 'scheduled') continue;
        const due = new Date(plan.scheduledAt).getTime();
        if (Number.isNaN(due) || due > now) continue;
        if (online && due >= bootedAt) {
          const snap = applyEffect(flag, plan, fmtNow());
          this.logAudit('定时生效', `${flag.key} 计划 ${fmt(plan.scheduledAt)}，实际 ${snap.effectiveAt}，采用规则版本 v${snap.version}（指纹 ${snap.fingerprint}）`, '系统');
        } else {
          plan.state = 'overdue';
          this.logAudit('过期待补发', `${flag.key} 计划 ${fmt(plan.scheduledAt)} 已过点（${online ? '应用重启前已过期' : '离线未恢复'}），待值班人确认补发`, '系统');
        }
      }
    },
    confirmReissue(actor = '值班人') {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || plan.state !== 'overdue') return;
      const snap = applyEffect(flag, plan, fmtNow());
      this.logAudit('补发生效', `${flag.key} 计划 ${fmt(plan.scheduledAt)}，实际补发 ${snap.effectiveAt}，采用规则版本 v${snap.version}（指纹 ${snap.fingerprint}）`, actor);
    },
    emergencyStop() { if (!this.active) return; this.active.enabled = false; this.active.status = 'stopped'; this.logAudit('紧急停止', `${this.active.key} 已立即关闭`); },
    rollback() { if (!this.active) return; this.active.enabled = false; this.active.rollout = 0; this.active.status = 'rolled-back'; this.logAudit('执行回滚', `${this.active.key} 回滚至关闭状态`); },
    // 条件命中与放量分开：用户标识 → 地区 → 登录要求 → 版本依次判断，全部通过后才按用户算稳定灰度桶
    evaluate(user: EvalUser): EvalResult | null {
      const flag = this.active;
      if (!flag) return null;
      const steps: ConditionStep[] = [];
      const uid = user.id.trim();
      steps.push({ key: 'identity', label: '用户标识', pass: uid.length > 0, detail: uid ? `标识 ${uid} 可参与分桶` : '标识为空，无法计算灰度桶' });
      if (uid) {
        const regionPass = flag.rules.region === '全部' || flag.rules.region === user.region;
        steps.push({ key: 'region', label: '地区', pass: regionPass, detail: flag.rules.region === '全部' ? '不限地区' : `要求 ${flag.rules.region}，实际 ${user.region || '未知'}` });
        if (regionPass) {
          const authPass = !flag.rules.authenticated || user.authenticated;
          steps.push({ key: 'auth', label: '登录要求', pass: authPass, detail: flag.rules.authenticated ? (user.authenticated ? '要求已登录，当前已登录' : '要求已登录，当前未登录') : '不要求登录' });
          if (authPass) {
            const verdict = versionSatisfies(user.appVersion, flag.rules.appVersion);
            steps.push({ key: 'version', label: '版本', pass: verdict !== false, detail: verdict === null ? `规则 ${flag.rules.appVersion} 无法解析，按不拦截处理` : `要求 ${flag.rules.appVersion}，实际 ${user.appVersion || '未知'}` });
          }
        }
      }
      const blocked = steps.find((step) => !step.pass) ?? null;
      const bucket = blocked ? null : bucketOf(flag.key, uid);
      const bucketHit = bucket !== null && bucket < flag.rollout;
      const hit = flag.enabled && !blocked && bucketHit;
      const parts: string[] = [];
      if (blocked) {
        parts.push(`被「${blocked.label}」拦下：${blocked.detail}`);
      } else {
        parts.push('条件依次通过：用户标识 → 地区 → 登录要求 → 版本');
        parts.push(bucketHit ? `灰度桶 ${bucket} < ${flag.rollout}%，落入放量范围` : `灰度桶 ${bucket} ≥ ${flag.rollout}%，未落入放量范围`);
      }
      if (!flag.enabled) parts.push('开关未启用，以上为预演结果');
      return { hit, blockedBy: blocked?.label ?? null, steps, bucket, rollout: flag.rollout, enabled: flag.enabled, reason: parts.join('；') };
    }
  }
});
