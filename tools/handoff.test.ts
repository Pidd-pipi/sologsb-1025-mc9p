// 规则引擎验证脚本：npx tsc 编译后由 node 运行（不进入 Angular 构建）
declare const process: { exit(code?: number): never };
import { acquireSlot, confirmRole, evaluatePublish, exportHandoff, importHandoff, publish, releaseSlot, resolveConflict, resolvePendingDraft, updateContent } from '../src/app/handoff/handoff.engine';
import { initialHandoffLedger, NOTICE_ID } from '../src/app/handoff/handoff.seed';
import { Ledger, Result, SlotClaim } from '../src/app/handoff/handoff.model';

const V = '2026.10.3-2';
const KEY = (channelId: string, locale: string, version = V) => `${NOTICE_ID}|${version}|${channelId}|${locale}`;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected rejection: ${r.reason} ${r.message}`);
  return r.value;
}
function denied<T>(r: Result<T>, reason: string): boolean {
  return !r.ok && r.reason === reason;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// 1. 初始台账：新版本盖掉旧排期
{
  console.log('[1] 新版本抢占盖掉旧排期');
  const l = initialHandoffLedger();
  const oldV1 = l.claims.find((c) => c.version === '2026.10.3-1' && c.channelId === 'sms');
  check('旧版短信名额已失效', !!oldV1 && !oldV1.valid);
  const v2sms = l.claims.find((c) => c.key === KEY('sms', 'zh-CN'));
  check('新版短信名额有效且接管人为林晓', !!v2sms && v2sms.valid && v2sms.operator === '林晓');
  check('短信 zh-CN 双角色已确认', v2sms?.confirms.every((c) => c.status === 'confirmed') === true);
}

// 2. 越权提交被拒绝
{
  console.log('[2] 值班员越权提交别的渠道被拒绝');
  let l = initialHandoffLedger();
  const r = acquireSlot(l, { windowId: 'win-night', noticeId: NOTICE_ID, version: V, channelId: 'broadcast', locale: 'en', contentRev: 3 });
  check('夜班越权广播被拒 overreach', denied(r, 'overreach'));
  if (!r.ok) l = r.ledger;
  check('越权不留待处理稿', l.pendingDrafts.length === 0);
  const logHit = l.log.some((e) => e.level === 'danger' && e.text.includes('越权'));
  check('审计日志记录越权', logHit);
}

// 3. 抢同一位只能一人成功，失败方留待处理稿并显示接管人
{
  console.log('[3] 同一名额抢占唯一 + 待处理稿接管人');
  let l = initialHandoffLedger();
  const r = acquireSlot(l, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: V, channelId: 'broadcast', locale: 'zh-CN', contentRev: 3 });
  check('后抢方失败 slot-taken', denied(r, 'slot-taken'), !r.ok ? r.reason : '');
  if (!r.ok) l = r.ledger;
  check('留下一条待处理稿', l.pendingDrafts.filter((d) => d.status === 'open').length === 1);
  const pending = l.pendingDrafts[0];
  check('待处理稿显示接管人', pending.takeover?.operator === '林晓' && pending.takeover.windowId === 'win-day');
  const holder = l.claims.find((c) => c.key === KEY('broadcast', 'zh-CN'));
  check('渠道仍是先抢方占用', holder?.valid === true && holder.operator === '林晓');

  // 释放后失败方通过待处理稿重新抢占
  l = releaseSlot(l, KEY('broadcast', 'zh-CN'), 'win-day');
  const retryResult = resolvePendingDraft(l, l.pendingDrafts[0].id, 'retry');
  check('释放后重试成功', 'ok' in retryResult && retryResult.ok);
  l = retryResult.ledger;
  check('待处理稿状态更新为 retaken', l.pendingDrafts.every((d) => d.status !== 'open'));
}

// 4. 渠道有限名额
{
  console.log('[4] 有限渠道名额上限');
  let l = initialHandoffLedger();
  // 短信容量 2：已有 zh-CN，再占 en 成功
  const r1 = acquireSlot(l, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: V, channelId: 'sms', locale: 'en', contentRev: 3 });
  check('短信第二个名额可占', r1.ok);
  if (r1.ok) l = r1.ledger;
  const r2 = acquireSlot(l, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: V, channelId: 'sms', locale: 'ja', contentRev: 3 });
  check('短信第三个名额被拒 capacity-full', denied(r2, 'capacity-full'));
  if (!r2.ok) l = r2.ledger;
  check('名额满也留待处理稿并标注接管人', l.pendingDrafts.some((d) => d.reason === 'capacity-full' && d.locale === 'ja' && !!d.takeover));
}

// 5. 版本凭据：正文/标题变动 → 名额与确认失效重算；未触达语言保留
{
  console.log('[5] 内容凭据失效重算 / 未触达语言保留');
  let l = initialHandoffLedger();
  const before = l.notices[NOTICE_ID].versions[V].contentRev;
  const upd = updateContent(l, {
    noticeId: NOTICE_ID, version: V,
    changes: [{ locale: 'zh-CN', body: l.notices[NOTICE_ID].versions[V].locales['zh-CN'].body + '请服从现场指挥。' }]
  });
  l = upd.ledger;
  check('contentRev 自增', l.notices[NOTICE_ID].versions[V].contentRev === before + 1);
  const zhClaims = l.claims.filter((c) => c.locale === 'zh-CN' && c.version === V);
  check('触达语言名额全部失效', zhClaims.every((c) => !c.valid));
  check('角色确认同时清空', zhClaims.every((c) => c.confirms.every((x) => x.status === 'pending')));
  check('未触达语言 en 名额照常保留', upd.summary.retainedLocales.includes('en'));
  const enClaim = l.claims.find((c) => c.key === KEY('wechat', 'en'));
  check('英文确认/占用未受影响', enClaim?.valid === true);

  // 旧凭据抢占被拒
  const stale = acquireSlot(l, { windowId: 'win-day', noticeId: NOTICE_ID, version: V, channelId: 'sms', locale: 'zh-CN', contentRev: before });
  check('旧凭据抢占拒绝 stale-content', denied(stale, 'stale-content'));
}

// 6. 影响范围变动 → 全部语言重算
{
  console.log('[6] 影响范围变动');
  let l = initialHandoffLedger();
  const r = updateContent(l, { noticeId: NOTICE_ID, version: V, scope: '扩大至全市沿江街道', changes: [] });
  l = r.ledger;
  check('全部有效名额失效', l.claims.filter((c) => c.valid).length === 0);
  check('汇总标记 scopeChanged', r.summary.scopeChanged === true);
}

// 7. 失效名额不能确认
{
  console.log('[7] 失效名额的确认被忽略');
  let l = initialHandoffLedger();
  l = updateContent(l, { noticeId: NOTICE_ID, version: V, changes: [{ locale: 'zh-CN', title: '新标题' }] }).ledger;
  const rev = l.revision;
  l = confirmRole(l, KEY('sms', 'zh-CN'), '值班长复核', '老班长');
  check('对失效名额确认不产生修订', l.revision === rev);
}

// 8. 断网交接：同渠道两边都改 → 待决项，处理前不能发布
{
  console.log('[8] 断网交接合并 + 待决阻断发布');
  const local = initialHandoffLedger();
  const remote = clone(local);

  // 本地（发布席）抢占 wechat/ja
  let l = local;
  const la = acquireSlot(l, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: V, channelId: 'wechat', locale: 'ja', contentRev: 3 });
  if (la.ok) l = la.ledger; else throw new Error('local acquire failed');
  check('本地抢占 wechat/ja 成功', la.ok);

  // 对端（夜班，断网副本）抢占同一个 wechat/ja + 单边 screen/zh-CN
  let rLedger = remote;
  const ra = acquireSlot(rLedger, { windowId: 'win-night', noticeId: NOTICE_ID, version: V, channelId: 'wechat', locale: 'ja', contentRev: 3 });
  if (ra.ok) rLedger = ra.ledger;
  const rb = acquireSlot(rLedger, { windowId: 'win-night', noticeId: NOTICE_ID, version: V, channelId: 'screen', locale: 'zh-CN', contentRev: 3 });
  if (rb.ok) rLedger = rb.ledger;
  check('对端同样抢占成功（各自副本）', ra.ok && rb.ok);

  const pkg = exportHandoff(rLedger, 'win-night')!;
  check('交接包按通知+版本携带内容', !!pkg.notices[NOTICE_ID].versions[V]);
  const merged = importHandoff(l, pkg);
  l = merged.ledger;
  check('列出 1 项待决（同一渠道两边都改）', merged.summary.conflictKeys.length === 1 && merged.summary.conflictKeys[0] === KEY('wechat', 'ja'));
  check('单边改动 screen/zh-CN 直接采纳', merged.summary.adoptedKeys.includes(KEY('screen', 'zh-CN')));
  const conflict = l.conflicts[0];
  check('待决项记录两边接管人', conflict.local.operator === '陈岚' && conflict.remote.operator === '周海');
  check('待决期间本地名额冻结', l.claims.find((c) => c.key === KEY('wechat', 'ja'))?.valid === false);

  const blockersWhileConflict = evaluatePublish(l, 'win-publisher', NOTICE_ID, V);
  check('有待决项时不能发布', blockersWhileConflict.some((b) => b.code === 'conflict-open'));
  const pubBlocked = publish(l, 'win-publisher', NOTICE_ID, V);
  check('发布调用被拒', !pubBlocked.ok);
  if (!pubBlocked.ok) l = pubBlocked.ledger;

  // 采用对端处理待决
  l = resolveConflict(l, conflict.id, 'remote');
  check('待决项清除', l.conflicts.length === 0);
  const resolved = l.claims.find((c) => c.key === KEY('wechat', 'ja'));
  check('名额恢复且归属夜班、确认重置', resolved?.valid === true && resolved.operator === '周海' && resolved.confirms.every((c) => c.status === 'pending'));
}

// 9. 单边释放合并：对端释放 wechat/en，本地未动 → 采纳释放
{
  console.log('[9] 断网期间单边释放');
  const local = initialHandoffLedger();
  let remote = clone(local);
  remote = releaseSlot(remote, KEY('wechat', 'en'), 'win-night');
  const pkg = exportHandoff(remote, 'win-night')!;
  const merged = importHandoff(local, pkg);
  const enClaim = merged.ledger.claims.find((c) => c.key === KEY('wechat', 'en'));
  check('合并后名额释放', enClaim?.valid === false);
  check('不产生待决项', merged.summary.conflictKeys.length === 0);
}

// 10. 通知+版本内容合并：高 contentRev 胜
{
  console.log('[10] 交接包按通知和版本合并内容');
  const local = initialHandoffLedger();
  const withNew = updateContent(local, { noticeId: NOTICE_ID, version: V, changes: [{ locale: 'zh-CN', body: '本地新增内容：请立即转移。' }] }).ledger;
  // 对端停留在旧内容，合并后保留本地新高凭据
  const remote = clone(initialHandoffLedger());
  const pkg = exportHandoff(remote, 'win-night')!;
  const merged = importHandoff(withNew, pkg);
  check('本地较新内容不被旧交接包覆盖', merged.ledger.notices[NOTICE_ID].versions[V].locales['zh-CN'].body.includes('本地新增内容'));
}

// 11. 完整发布链路
{
  console.log('[11] 满足全部门禁后交接发布成功');
  let l: Ledger = initialHandoffLedger();
  // 为缺失的 ja 占名额（wechat 容量 3）
  const ja = acquireSlot(l, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: V, channelId: 'wechat', locale: 'ja', contentRev: 3 });
  if (ja.ok) l = ja.ledger;
  const before = evaluatePublish(l, 'win-publisher', NOTICE_ID, V);
  check('初始有确认类阻断', before.length > 0 && before.every((b) => b.code === 'confirm-pending'));
  // 对所有有效名额补齐双确认
  l.claims.filter((c) => c.valid).forEach((c) => {
    l = confirmRole(l, c.key, '值班长复核', '老班长');
    l = confirmRole(l, c.key, '发布人确认', '陈岚');
  });
  check('确认齐备后无阻断', evaluatePublish(l, 'win-publisher', NOTICE_ID, V).length === 0);
  const pub = publish(l, 'win-publisher', NOTICE_ID, V);
  check('发布成功', pub.ok, !pub.ok ? pub.message : '');
  if (pub.ok) l = pub.ledger;
  check('版本标记已发布', l.notices[NOTICE_ID].versions[V].published === true);
  // 已发布后不能再抢占
  const again = acquireSlot(l, { windowId: 'win-day', noticeId: NOTICE_ID, version: V, channelId: 'sms', locale: 'en', contentRev: 3 });
  check('已发布版本拒绝再抢占', denied(again, 'already-published'));
  // 值班员窗口无发布权限
  const l2 = initialHandoffLedger();
  check('白班无发布权限', evaluatePublish(l2, 'win-day', NOTICE_ID, V).some((b) => b.code === 'publish-forbidden'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
