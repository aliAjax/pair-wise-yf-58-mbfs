// 冒烟测试：条件/放量分离、稳定桶、指纹失效、过期补发
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear()
};

const { createPinia, setActivePinia } = await import('pinia');
const flags = await import('./src/stores/flags.ts');
setActivePinia(createPinia());

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}`); }
}

// ---- 纯函数 ----
check('灰度桶稳定：同一 key+用户 多次计算一致', flags.bucketOf('checkout-v2', 'user-1042') === flags.bucketOf('checkout-v2', 'user-1042'));
check('灰度桶在 0-99', flags.bucketOf('checkout-v2', 'user-1042') >= 0 && flags.bucketOf('checkout-v2', 'user-1042') < 100);
check('版本比较 >= 通过', flags.versionSatisfies('8.3.0', '>= 8.2') === true);
check('版本比较 >= 拦截', flags.versionSatisfies('8.1.0', '>= 8.2') === false);
check('用户版本无法解析 → 拦截', flags.versionSatisfies('abc', '>= 8.2') === false);
check('规则无法解析 → null（不拦截）', flags.versionSatisfies('8.3.0', 'garbage') === null);
const fpA = flags.fingerprintOf({ region: '上海', appVersion: '>= 8.2', authenticated: true });
const fpB = flags.fingerprintOf({ region: '全部', appVersion: '>= 8.2', authenticated: true });
check('规则一改指纹就变', fpA !== fpB);

// ---- 过期补发流程（种子 f1 定时 2026-10-01 10:00，早于启动时间）----
const store = flags.useFlagStore();
store.select('f1');
store.checkScheduled(true);
check('重启后发现已过点 → 记为过期待补发', store.activePlan.state === 'overdue' && store.active.status === 'scheduled');
check('过期审计已记录', store.audit.some((a) => a.action === '过期待补发' && a.detail.includes('2026-10-01 10:00')));
store.confirmReissue();
check('值班人确认后补发生效', store.active.enabled && store.active.status === 'rolling' && store.activePlan.state === 'effective');
check('补发快照采用规则版本 v3', store.activePlan.snapshot?.version === 3);
const reissueAudit = store.audit.find((a) => a.action === '补发生效');
check('补发审计含计划时间/实际时间/规则版本', !!reissueAudit && reissueAudit.detail.includes('计划 2026-10-01 10:00') && reissueAudit.detail.includes('实际补发') && reissueAudit.detail.includes('v3'));

// ---- 条件依次判断 + 结果说明 ----
const uid = 'user-1042';
let r = store.evaluate({ id: uid, region: '上海', appVersion: '8.3.0', authenticated: true });
check('全部条件通过时给出 4 步 + 桶号', r.steps.length === 4 && r.steps.every((s) => s.pass) && r.bucket === flags.bucketOf('checkout-v2', uid));
check('结果说明写清条件通过与桶号', r.reason.includes('条件依次通过') && r.reason.includes(`灰度桶 ${r.bucket}`));
r = store.evaluate({ id: uid, region: '北京', appVersion: '8.3.0', authenticated: true });
check('地区不符 → 被「地区」拦下，判断到此为止', r.blockedBy === '地区' && r.steps.length === 2 && r.reason.includes('被「地区」拦下'));
r = store.evaluate({ id: '  ', region: '上海', appVersion: '8.3.0', authenticated: true });
check('空用户标识 → 第一步拦下', r.blockedBy === '用户标识' && r.steps.length === 1);
r = store.evaluate({ id: uid, region: '上海', appVersion: '8.3.0', authenticated: false });
check('未登录 → 被「登录要求」拦下', r.blockedBy === '登录要求' && r.steps.length === 3);
r = store.evaluate({ id: uid, region: '上海', appVersion: '8.1.0', authenticated: true });
check('版本不足 → 被「版本」拦下', r.blockedBy === '版本' && r.steps.length === 4);

// ---- 条件放宽后原先命中的用户仍命中 ----
const before = store.evaluate({ id: uid, region: '上海', appVersion: '8.3.0', authenticated: true });
store.updateRule({ region: '全部' });
const after = store.evaluate({ id: uid, region: '上海', appVersion: '8.3.0', authenticated: true });
check('放宽后桶号不变', before.bucket === after.bucket);
check('放宽后原先命中结论不变', before.hit === after.hit);
check('放宽审计注明已命中用户仍命中', store.audit[0].action === '修改规则' && store.audit[0].detail.includes('规则放宽') && store.audit[0].detail.includes('仍命中'));
check('规则版本递增到 v4', store.active.ruleVersion === 4);

// ---- 审批后改规则 → 指纹失效 → 退回草稿 ----
store.emergencyStop();
store.approve('产品负责人');
store.approve('研发负责人');
check('双审批通过', store.active.status === 'approved' && store.approvalsValid);
const fpBefore = store.currentFingerprint;
store.updateRule({ appVersion: '>= 8.3' });
check('改规则后指纹变化', store.currentFingerprint !== fpBefore);
check('旧批准失效，退回草稿', store.active.status === 'draft' && store.activePlan.approvals.length === 0);
check('审计注明收紧只拦条件外的人 + 退回重审', store.audit[0].detail.includes('新增/收紧条件') && store.audit[0].detail.includes('退回草稿重新审批'));
store.startRollout();
check('草稿状态不能放量', store.active.status === 'draft' && !store.active.enabled);
store.approve('产品负责人');
store.approve('研发负责人');
store.startRollout();
check('重新审批后可放量，快照更新到 v5', store.active.status === 'rolling' && store.activePlan.snapshot?.version === 5);

// ---- 停止后恢复 + 定时准点生效（在线且过点发生在运行期间）----
const localInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
store.emergencyStop();
check('停止后保留有效批准', store.active.status === 'stopped' && store.approvalsValid);
store.startRollout();
check('指纹未变可直接恢复放量', store.active.status === 'rolling' && store.audit[0].action === '恢复放量');
store.emergencyStop();
store.schedule(localInput(new Date(Date.now() + 60 * 1000)));
check('指纹未变可直接重排定时', store.active.status === 'scheduled' && store.activePlan.state === 'scheduled');
const localSec = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
store.activePlan.scheduledAt = localSec(new Date(Date.now() + 1500)); // 1.5 秒后到点（启动之后）
await new Promise((resolve) => setTimeout(resolve, 2000)); // 等到过点
store.checkScheduled(true);
check('在线到点 → 准点生效', store.active.status === 'rolling' && store.activePlan.state === 'effective');
check('定时生效审计含计划/实际/版本', store.audit.some((a) => a.action === '定时生效' && a.detail.includes('计划') && a.detail.includes('实际') && a.detail.includes('v5')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
