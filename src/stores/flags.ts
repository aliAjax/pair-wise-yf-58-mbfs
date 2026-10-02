import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; stickyUsers: string[]; }
export interface RuleSnapshot { version: number; fingerprint: string; rules: RuleSet; rollout: number; effectiveAt: string; }
export interface MakeupRecord { status: 'pending' | 'confirmed'; plannedAt: string; makeupAt: string | null; ruleVersion: number | null; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; approvedFingerprint: string | null; lastSnapshot: RuleSnapshot | null; makeup: MakeupRecord | null; armed: boolean; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }
export interface RuleCheck { rule: string; pass: boolean; detail: string; }
export interface SimResult { hit: boolean; reason: string; checks: RuleCheck[]; bucket: number | null; sticky: boolean; }

interface State { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; }

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', stickyUsers: [] },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', stickyUsers: ['user-1042'] }
  ],
  plans: [{ id: 'p1', flagId: 'f1', scheduledAt: '2026-10-03T10:00', approvals: [], version: 3, approvedFingerprint: null, lastSnapshot: null, makeup: null, armed: false }],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

function load(): State { const saved = localStorage.getItem('yf58-flag-state'); return saved ? JSON.parse(saved) as State : structuredClone(seed); }

/** FNV-1a 32 位哈希：同一用户标识永远落在同一个灰度桶，分布稳定。 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 规则内容指纹：地区 / 版本 / 登录要求任一变化，指纹立即变化。 */
export function fingerprintOf(rules: RuleSet): string {
  return fnv1a(`${rules.region}|${rules.appVersion}|${rules.authenticated ? 1 : 0}`).toString(16).padStart(8, '0');
}

function parseVersion(value: string): [number, number, number] {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** 简易版本范围匹配，支持 >= <= > < = 以及空格分隔的组合（如 ">= 8.0 < 9.0"）。 */
export function satisfiesVersion(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '全部' || trimmed === '*') return true;
  const current = parseVersion(version);
  const tokenPattern = /(\^|~|>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)/g;
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(trimmed)) !== null) {
    const op = token[1] ?? '=';
    const target = parseVersion(token[2]);
    const cmp = compareVersion(current, target);
    switch (op) {
      case '>=': if (cmp < 0) return false; break;
      case '<=': if (cmp > 0) return false; break;
      case '>': if (cmp <= 0) return false; break;
      case '<': if (cmp >= 0) return false; break;
      case '=': if (cmp !== 0) return false; break;
      case '^': if (cmp < 0 || current[0] !== target[0]) return false; break;
      case '~': if (cmp < 0 || current[0] !== target[0] || current[1] !== target[1]) return false; break;
    }
  }
  return true;
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state', JSON.stringify(this.$state)); },
    logAudit(action: string, detail: string, actor = '当前操作人') { this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor, action, detail }); this.persist(); },
    select(id: string) { this.activeId = id; this.persist(); },

    /** 规则变更：版本号递增，内容指纹变化后已批准的发布立即失效，退回草稿重新审批。 */
    updateRule(rule: Partial<RuleSet>) {
      if (!this.active || !this.activePlan) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.activePlan.version += 1;
      if (this.activePlan.approvedFingerprint !== null) {
        this.activePlan.approvals = [];
        this.activePlan.approvedFingerprint = null;
        this.activePlan.makeup = null;
        this.activePlan.armed = false;
        this.active.status = 'draft';
        this.logAudit('规则变更', `规则版本升至 v${this.activePlan.version}，内容指纹变更为 ${fingerprintOf(this.active.rules)}，已批准内容失效，退回草稿重新审批`);
      } else {
        this.logAudit('修改规则', `规则版本 v${this.activePlan.version}：${JSON.stringify(this.active.rules)}`);
      }
    },

    setRollout(value: number) { if (!this.active) return; this.active.rollout = value; this.logAudit('调整放量', `${this.active.key} → ${value}%`); },

    schedule(value: string) {
      if (!this.active || !this.activePlan) return;
      this.activePlan.scheduledAt = value;
      this.activePlan.makeup = null;
      this.activePlan.armed = false;
      this.active.status = 'scheduled';
      this.logAudit('设置定时', `${this.active.key} 于 ${value} 生效`);
    },

    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      if (this.activePlan.approvals.length >= 2) {
        const fingerprint = fingerprintOf(this.active.rules);
        this.activePlan.approvedFingerprint = fingerprint;
        this.active.status = 'approved';
        this.logAudit('审批发布', `${role} 已确认 ${this.active.key}，规则版本 v${this.activePlan.version}，内容指纹 ${fingerprint}`);
      } else {
        this.active.status = 'draft';
        this.logAudit('审批发布', `${role} 已确认 ${this.active.key}，等待另一审批人`);
      }
      this.persist();
    },

    /** 发布生效：写入最近一次生效的规则快照（版本 + 指纹 + 规则内容 + 放量）。 */
    applyRelease(flag: FeatureFlag, plan: RolloutPlan, mode: 'manual' | 'scheduled' | 'makeup') {
      const snapshot: RuleSnapshot = {
        version: plan.version,
        fingerprint: fingerprintOf(flag.rules),
        rules: { ...flag.rules },
        rollout: flag.rollout,
        effectiveAt: new Date().toISOString()
      };
      plan.lastSnapshot = snapshot;
      flag.enabled = true;
      flag.status = 'rolling';
      if (mode === 'makeup') {
        const makeupAt = new Date().toISOString();
        plan.makeup = { status: 'confirmed', plannedAt: plan.scheduledAt, makeupAt, ruleVersion: snapshot.version };
        this.logAudit('定时补发', `${flag.key} 计划时间 ${plan.scheduledAt} 已过点，值班人确认后于 ${makeupAt} 补发，采用规则版本 v${snapshot.version}（指纹 ${snapshot.fingerprint}）`);
      } else if (mode === 'scheduled') {
        this.logAudit('定时生效', `${flag.key} 按计划 ${plan.scheduledAt} 生效，采用规则版本 v${snapshot.version}（指纹 ${snapshot.fingerprint}）`);
      }
      this.persist();
    },

    startRollout() {
      if (!this.active || !this.activePlan || this.active.status !== 'approved') return;
      this.applyRelease(this.active, this.activePlan, 'manual');
      this.logAudit('开始放量', `${this.active.key} 启用 ${this.active.rollout}%，规则版本 v${this.activePlan.version}`);
    },

    emergencyStop() { if (!this.active) return; this.active.enabled = false; this.active.status = 'stopped'; this.logAudit('紧急停止', `${this.active.key} 已立即关闭`); },

    rollback() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.rollout = 0;
      this.active.status = 'rolled-back';
      this.active.stickyUsers = [];
      this.logAudit('执行回滚', `${this.active.key} 回滚至关闭状态，已清空放量粘性用户`);
    },

    /**
     * 定时生效巡检：由界面定时器 / 上线时调用。
     * 在线且已武装（本次运行期间见到过未到点）→ 正常生效；
     * 断网期间到点或重开时已过点 → 记为过期待补发，等值班人确认。
     */
    checkScheduled(online: boolean) {
      for (const flag of this.flags) {
        if (flag.status !== 'scheduled') continue;
        const plan = this.plans.find((item) => item.flagId === flag.id);
        if (!plan || plan.makeup) continue;
        const due = new Date(plan.scheduledAt).getTime() <= Date.now();
        if (!due) { plan.armed = true; continue; }
        if (online && plan.armed) {
          this.applyRelease(flag, plan, 'scheduled');
        } else {
          plan.makeup = { status: 'pending', plannedAt: plan.scheduledAt, makeupAt: null, ruleVersion: null };
          this.logAudit('过期待补发', `${flag.key} 计划时间 ${plan.scheduledAt} 已过点且未生效（断网或重开），记为过期待补发，待值班人确认`);
        }
      }
    },

    confirmMakeup() {
      if (!this.active || !this.activePlan || this.activePlan.makeup?.status !== 'pending') return;
      this.applyRelease(this.active, this.activePlan, 'makeup');
    },

    /**
     * 模拟命中：条件与放量分离。
     * 依次判断 用户标识 → 地区 → 登录要求 → 版本，全部通过后再按用户标识算稳定灰度桶；
     * 已命中过的用户保持放量粘性（条件放宽后原先命中的用户仍命中，只有新增条件才拦住外面的人）。
     * 返回每条规则的通过 / 拦下说明。
     */
    simulateHit(user: { id: string; region: string; appVersion: string; authenticated: boolean }): SimResult {
      const checks: RuleCheck[] = [];
      const reject = (rule: string, detail: string): SimResult => {
        checks.push({ rule, pass: false, detail });
        return { hit: false, reason: detail, checks, bucket: null, sticky: false };
      };
      if (!this.active) return reject('开关', '未选择功能开关');
      if (!this.active.enabled) return reject('开关状态', '开关未启用');
      const rule = this.active.rules;

      if (!user.id.trim()) return reject('用户标识', '用户标识为空，无法判定灰度桶');
      checks.push({ rule: '用户标识', pass: true, detail: `标识 ${user.id}` });

      if (rule.region !== '全部' && rule.region !== user.region) {
        return reject('地区', `地区不通过：要求 ${rule.region}，当前 ${user.region}`);
      }
      checks.push({ rule: '地区', pass: true, detail: `当前地区 ${user.region} 符合要求` });

      if (rule.authenticated && !user.authenticated) {
        return reject('登录要求', '登录要求不通过：需要已登录用户');
      }
      checks.push({ rule: '登录要求', pass: true, detail: rule.authenticated ? '用户已登录' : '不要求登录' });

      if (!satisfiesVersion(user.appVersion, rule.appVersion)) {
        return reject('版本', `版本不通过：要求 ${rule.appVersion}，当前 ${user.appVersion}`);
      }
      checks.push({ rule: '版本', pass: true, detail: `版本 ${user.appVersion} 满足 ${rule.appVersion}` });

      const bucket = fnv1a(user.id) % 100;
      const sticky = this.active.stickyUsers.includes(user.id);
      const hit = sticky || bucket < this.active.rollout;
      if (hit && !sticky) {
        this.active.stickyUsers.push(user.id);
        this.persist();
      }
      const reason = sticky
        ? '历史已命中，保持放量'
        : hit
          ? `灰度桶 ${bucket} < ${this.active.rollout}%`
          : `灰度桶 ${bucket} ≥ ${this.active.rollout}%`;
      checks.push({ rule: '灰度桶', pass: hit, detail: reason });
      return { hit, reason, checks, bucket, sticky };
    }
  }
});
