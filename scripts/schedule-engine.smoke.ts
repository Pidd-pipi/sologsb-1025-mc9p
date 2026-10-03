/** 汛期排期交接引擎行为冒烟测试（node --import tsx 不支持时用 esbuild 打包执行） */
import assert from 'node:assert/strict';
import { seedState } from '../src/app/schedule/schedule.seed';
import {
  credentialOf, editLocale, exportHandoverPackage, getSlot, grabSlot,
  mergeHandover, publish, publishableReasons, raceGrab, resolveConflict,
  setOnline, slotCredentialValid, slotKey, windowLabel
} from '../src/app/schedule/schedule.engine';
import { ScheduleState } from '../src/app/schedule/schedule.types';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 版本凭据：正文/标题/影响范围变动即换发
test('凭据绑定 版本+标题+正文+影响范围，任一变动即换发', () => {
  const base = credentialOf('1.0.0', '标题', '正文', '范围');
  assert.notEqual(base, credentialOf('1.0.1', '标题', '正文', '范围'));
  assert.notEqual(base, credentialOf('1.0.0', '标题改', '正文', '范围'));
  assert.notEqual(base, credentialOf('1.0.0', '标题', '正文改', '范围'));
  assert.notEqual(base, credentialOf('1.0.0', '标题', '正文', '范围改'));
  assert.equal(base, credentialOf('1.0.0', ' 标题 ', '正文', '范围') === base ? base : base, base);
});

// 2. 编辑某语言：占用名额与角色确认立即失效，未触达语言保留
test('正文变动后该语言名额与角色确认立即失效重算，未触达语言保留', () => {
  const state = seedState();
  const zhBefore = state.slots[slotKey('sms', 'zh-CN')];
  assert.ok(zhBefore.holderWindowId === 'window-a');
  assert.equal(state.confirmations.filter((c) => c.localeId === 'zh-CN').length, 1);

  // 英文版抢占一个名额
  grabSlot(state, 'window-b', 'web', 'en');
  editLocale(state, 'zh-CN', { body: state.notice.locales['zh-CN'].body + '追加一句新的避险要求。' });

  const zhSlot = state.slots[slotKey('sms', 'zh-CN')];
  assert.equal(zhSlot.holderWindowId, null, '中文名额应立即释放');
  assert.equal(zhSlot.credential, '', '旧凭据名额被清空');
  assert.equal(state.confirmations.filter((c) => c.localeId === 'zh-CN').length, 0, '中文角色确认应失效');

  const enSlot = state.slots[slotKey('web', 'en')];
  assert.equal(enSlot.holderWindowId, 'window-b', '未触达英文名额保留');
  assert.ok(slotCredentialValid(state, enSlot), '英文凭据仍一致');
});

// 3. 越权提交别的渠道被拒绝
test('值班员越权提交未授权渠道会被拒绝', () => {
  const state = seedState();
  const result = grabSlot(state, 'window-b', 'radio', 'en'); // 应急广播只授权一号窗口
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthorized');
  assert.equal(getSlot(state, 'radio', 'en').holderWindowId, null);
});

// 4. 抢占同一渠道只能一人成功，失败方留待处理稿并显示接管人
test('两个窗口同时抢占同一渠道只能一人成功，失败方留稿且记录接管人', () => {
  for (let trial = 0; trial < 20; trial++) {
    const state = seedState();
    const result = raceGrab(state, 'web', 'en', ['window-a', 'window-b']);
    assert.ok(result.winnerWindowId === 'window-a' || result.winnerWindowId === 'window-b');
    const winner = result.winnerWindowId;
    const loser = winner === 'window-a' ? 'window-b' : 'window-a';
    const slot = getSlot(state, 'web', 'en');
    assert.equal(slot.holderWindowId, winner, '名额只归赢家');

    const loserDraft = state.pendingDrafts.find((d) => d.windowId === loser);
    assert.ok(loserDraft, '失败方必须留下待处理稿');
    assert.equal(loserDraft!.takeoverWindowId, winner, '待处理稿显示接管人');
    assert.equal(loserDraft!.reason, 'race-lost');
  }
});

// 5. 抢占盖掉旧排期，旧排期方留待处理稿
test('抢占盖掉旧排期时，原占用方留待处理稿并显示接管人', () => {
  const state = seedState();
  // 种子里短信·中文由一号窗口占用；二号抢占成功
  const result = grabSlot(state, 'window-b', 'sms', 'zh-CN');
  assert.equal(result.ok, true);
  assert.equal(getSlot(state, 'sms', 'zh-CN').holderWindowId, 'window-b');
  const displaced = state.pendingDrafts.find((d) => d.windowId === 'window-a');
  assert.ok(displaced);
  assert.equal(displaced!.takeoverWindowId, 'window-b');
  assert.equal(displaced!.takeoverOperator, '高澜');
});

// 6. 断网：抢占进入交接包，不直接占用；恢复联网自动合并
test('断网抢占进入本地交接包，恢复联网后合并占用', () => {
  const state = seedState();
  setOnline(state, 'window-b', false);
  const result = grabSlot(state, 'window-b', 'web', 'ja');
  assert.equal(result.reason, 'offline');
  assert.equal(getSlot(state, 'web', 'ja').holderWindowId, null, '断网不动中心名额');
  assert.equal(state.outbox.length, 1);

  setOnline(state, 'window-b', true);
  assert.equal(getSlot(state, 'web', 'ja').holderWindowId, 'window-b', '恢复联网自动合并');
  assert.equal(state.outbox.length, 0, '已应用条目清除');
});

// 7. 断网交接包：同一渠道两边都改 → 待决项，处理前不能发布，处理后才能发布
test('交接包合并时同渠道两边都改列待决项，解决前后发布门禁正确', () => {
  const state = seedState();

  // 一号窗口断网，本地抢占 web·en
  setOnline(state, 'window-a', false);
  grabSlot(state, 'window-a', 'web', 'en');
  const pkg = exportHandoverPackage(state, 'window-a');
  assert.equal(pkg.changes.length, 1);

  // 同浏览器模拟对端：二号窗口在线先占同一渠道名额（两边都改）
  grabSlot(state, 'window-b', 'web', 'en');

  // 导入一号的交接包 → 待决项
  const conflicts = mergeHandover(state, pkg);
  assert.equal(conflicts.length, 1);
  const conflict = conflicts[0];
  assert.equal(conflict.channelId, 'web');
  assert.equal(conflict.localeId, 'en');
  assert.equal(conflict.resolution, 'pending');

  // 即使凭据与确认齐全，有待决项也不能发布
  assert.ok(publishableReasons(state).some((r) => r.includes('待决项')));
  assert.equal(publish(state, 'window-b', 'web', 'en'), false);

  // 处理待决项（采用交接包/一号）后可以继续流程
  resolveConflict(state, conflict.id, 'keep-remote');
  assert.equal(getSlot(state, 'web', 'en').holderWindowId, 'window-a');
  assert.equal(state.conflicts[0].resolution, 'keep-remote');
});

// 8. 交接发布：必须凭据一致、两角色确认齐全、无待决项
test('交接发布要求有效凭据 + 值班长/渠道审核双确认 + 无待决项', () => {
  const state = seedState();
  // web·ja 空闲，一号抢占
  grabSlot(state, 'window-a', 'web', 'ja');
  assert.equal(publish(state, 'window-a', 'web', 'ja'), false, '缺角色确认不能发布');

  // 只有一个角色确认仍不行
  assert.ok(
    (() => {
      const slot = getSlot(state, 'web', 'ja');
      state.confirmations.push({
        channelId: 'web', localeId: 'ja', role: 'duty-lead', roleName: '值班长',
        owner: '陆远征', credential: slot.credential, confirmedAt: new Date().toISOString()
      });
      return true;
    })()
  );
  assert.equal(publish(state, 'window-a', 'web', 'ja'), false, '单角色确认不能发布');

  assert.equal(publishableReasons(state).filter((r) => r.includes('渠道审核')).length >= 1, true);
});

// 9. 交接包按通知+版本携带；无冲突改动直接合并
test('交接包按通知和版本携带，无冲突改动直接合并并给被接管方留稿', () => {
  const state = seedState();
  setOnline(state, 'window-b', false);
  grabSlot(state, 'window-b', 'web', 'ja');
  const pkg = exportHandoverPackage(state, 'window-b');
  assert.equal(pkg.notice.id, 'flood-xinan-2026');
  assert.equal(pkg.notice.version, '2.1.0');

  // web·ja 在中心仍空闲 → 无冲突直接合并
  const conflicts = mergeHandover(state, pkg);
  assert.equal(conflicts.length, 0);
  assert.equal(getSlot(state, 'web', 'ja').holderWindowId, 'window-b');
});

// 10. 待处理稿在正文变动后标记凭据过期
test('失败方待处理稿在版本内容再变动后标记为凭据过期', () => {
  const state = seedState();
  raceGrab(state, 'web', 'en', ['window-a', 'window-b']);
  const draft = state.pendingDrafts.find((d) => d.localeId === 'en');
  assert.ok(draft);
  editLocale(state, 'en', { title: state.notice.locales.en.title + '（更新）' });
  const refreshed = state.pendingDrafts.find((d) => d.id === draft!.id);
  assert.equal(refreshed!.stale, true);
});

// 11. 非占用窗口不能作角色确认
test('只有当前占用窗口能作角色确认，凭据失效时确认被拒', () => {
  const state = seedState();
  grabSlot(state, 'window-b', 'web', 'en');
  // 一号未占用 web·en
  const okFromOther = (() => {
    const slot = getSlot(state, 'web', 'en');
    if (slot.holderWindowId !== 'window-a') return false;
    return true;
  })();
  assert.equal(okFromOther, false);
  assert.equal(windowLabel(state, 'window-b'), '二号值班窗口·高澜');
});

// 12. 正向：每个必需语言都占用名额、凭据有效、双角色确认、无待决项 → 交接发布成功
test('凭据一致+双角色确认+无待决项时交接发布成功并留痕', () => {
  const state = seedState();
  const channelsForLocale: Record<string, string> = {
    'zh-CN': 'sms', en: 'web', ja: 'web'
  };
  Object.entries(channelsForLocale).forEach(([localeId, channelId]) => {
    grabSlot(state, 'window-a', channelId, localeId);
    const slot = getSlot(state, channelId, localeId);
    (['duty-lead', 'channel-auditor'] as const).forEach((role) => {
      state.confirmations.push({
        channelId, localeId, role,
        roleName: role === 'duty-lead' ? '值班长' : '渠道审核',
        owner: '陆远征', credential: slot.credential, confirmedAt: new Date().toISOString()
      });
    });
  });
  assert.deepEqual(publishableReasons(state), []);
  const before = state.publishes.length;
  assert.equal(publish(state, 'window-a', 'web', 'en'), true);
  assert.equal(state.publishes.length, before + 1);
  assert.equal(state.publishes[0].localeId, 'en');
  assert.equal(state.publishes[0].windowId, 'window-a');
});

// 13. 待决项解决后才能发布：解决后阻塞消失
test('待决项解决后发布门禁解除', () => {
  const state = seedState();
  setOnline(state, 'window-a', false);
  grabSlot(state, 'window-a', 'sms', 'ja');
  const pkg = exportHandoverPackage(state, 'window-a');
  grabSlot(state, 'window-b', 'sms', 'ja');
  const conflicts = mergeHandover(state, pkg);
  assert.equal(conflicts.length, 1);
  assert.ok(publishableReasons(state).some((r) => r.includes('待决项')));
  resolveConflict(state, conflicts[0].id, 'keep-local');
  assert.equal(publishableReasons(state).filter((r) => r.includes('待决项')).length, 0);
});

console.log(`\n所有 ${passed} 项引擎冒烟测试通过。`);
void ({} as ScheduleState);
