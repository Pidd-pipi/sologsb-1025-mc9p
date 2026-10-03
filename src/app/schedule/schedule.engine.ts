/** 汛期渠道排期与交接发布：纯函数状态引擎 */

import {
  ChannelDef,
  ConflictResolution,
  DutyWindow,
  EventLog,
  GrabResult,
  HandoverPackage,
  OutboxChange,
  PendingDraft,
  RaceResult,
  RoleConfirmation,
  RoleKey,
  ScheduleLocale,
  ScheduleNotice,
  ScheduleState,
  SlotConflict,
  SlotState
} from './schedule.types';

let sequence = 0;
export function uid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 7)}`;
}

/** FNV-1a 32 位版本凭据：版本+标题+正文+影响范围任一变动即换发 */
export function credentialOf(version: string, title: string, body: string, scope: string): string {
  const text = `${version}|${title.trim()}|${body.trim()}|${scope.trim()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `vch-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function shortCredential(credential: string): string {
  return credential.replace(/^vch-/, '');
}

export function slotKey(channelId: string, localeId: string): string {
  return `${channelId}::${localeId}`;
}

export function findChannel(state: ScheduleState, channelId: string): ChannelDef | undefined {
  return state.channels.find((channel) => channel.id === channelId);
}

export function findWindow(state: ScheduleState, windowId: string): DutyWindow | undefined {
  return state.windows.find((window) => window.id === windowId);
}

export function getSlot(state: ScheduleState, channelId: string, localeId: string): SlotState {
  const key = slotKey(channelId, localeId);
  let slot = state.slots[key];
  if (!slot) {
    slot = {
      channelId, localeId,
      holderWindowId: null, holderOperator: '',
      credential: '', version: '',
      revisions: Object.fromEntries(state.windows.map((window) => [window.id, 0])),
      updatedAt: ''
    };
    state.slots[key] = slot;
  }
  return slot;
}

export function isAuthorized(channel: ChannelDef, windowId: string): boolean {
  return channel.authorizedWindows.includes(windowId);
}

export function localeValid(state: ScheduleState, localeId: string): boolean {
  const locale = state.notice.locales[localeId];
  if (!locale) return false;
  return state.channels.some((channel) => {
    const slot = state.slots[slotKey(channel.id, localeId)];
    return slot?.holderWindowId && slot.credential === locale.credential;
  });
}

/** 语言凭据是否与名额占用凭据一致（正文/标题/影响范围变动后立即 false） */
export function slotCredentialValid(state: ScheduleState, slot: SlotState): boolean {
  const locale = state.notice.locales[slot.localeId];
  return !!locale && slot.credential === locale.credential;
}

function pushLog(state: ScheduleState, level: EventLog['level'], message: string): void {
  state.logs.unshift({ id: uid('log'), level, message, createdAt: new Date().toISOString() });
  state.logs = state.logs.slice(0, 80);
}

function ensureSlotConfirmed(
  state: ScheduleState, slot: SlotState, role: RoleKey, roleName: string, owner: string
): void {
  if (!slot.holderWindowId) return;
  const exists = state.confirmations.find(
    (item) => item.channelId === slot.channelId && item.localeId === slot.localeId && item.role === role
  );
  if (exists) {
    exists.owner = owner;
    exists.credential = slot.credential;
    exists.confirmedAt = new Date().toISOString();
  } else {
    state.confirmations.push({
      channelId: slot.channelId, localeId: slot.localeId,
      role, roleName, owner, credential: slot.credential,
      confirmedAt: new Date().toISOString()
    });
  }
}

function releaseSlot(state: ScheduleState, slot: SlotState, windowId: string, message: string): void {
  const previous = slot.holderWindowId;
  slot.holderWindowId = null;
  slot.holderOperator = '';
  slot.credential = '';
  slot.version = '';
  slot.updatedAt = new Date().toISOString();
  if (windowId in slot.revisions) slot.revisions[windowId] += 1;
  state.confirmations = state.confirmations.filter(
    (item) => !(item.channelId === slot.channelId && item.localeId === slot.localeId)
  );
  pushLog(state, 'info', message + (previous ? `（原占用：${windowLabel(state, previous)}）` : ''));
}

export function windowLabel(state: ScheduleState, windowId: string | null): string {
  if (!windowId) return '空闲';
  const window = findWindow(state, windowId);
  return window ? `${window.name}·${window.operator}` : windowId;
}

/**
 * 编辑语言版本：正文、标题或影响范围变动后，该语言的占用名额与角色确认立即失效重算。
 * 未触达语言照常保留。
 */
export function editLocale(
  state: ScheduleState, localeId: string, patch: Partial<Pick<ScheduleLocale, 'title' | 'body' | 'scope'>>
): ScheduleState {
  const locale = state.notice.locales[localeId];
  if (!locale) return state;
  const before = credentialOf(locale.version, locale.title, locale.body, locale.scope);
  const nextTitle = patch.title ?? locale.title;
  const nextBody = patch.body ?? locale.body;
  const nextScope = patch.scope ?? locale.scope;
  const after = credentialOf(locale.version, nextTitle, nextBody, nextScope);
  if (before === after) return state;

  locale.title = nextTitle;
  locale.body = nextBody;
  locale.scope = nextScope;
  locale.credential = after;
  state.notice.updatedAt = new Date().toISOString();

  let invalidated = 0;
  state.channels.forEach((channel) => {
    const slot = state.slots[slotKey(channel.id, localeId)];
    if (slot?.holderWindowId && slot.credential !== after) {
      const previousHolder = slot.holderWindowId;
      // 占用名额立即失效：释放名额，等待按新凭据重新抢占
      slot.holderWindowId = null;
      slot.holderOperator = '';
      slot.credential = '';
      slot.version = '';
      slot.updatedAt = new Date().toISOString();
      invalidated += 1;

      // 该语言的角色确认绑定旧凭据，立即失效删除
      state.confirmations = state.confirmations.filter(
        (item) => !(item.channelId === channel.id && item.localeId === localeId)
      );

      // 原占用方的待处理稿（若有）标记为凭据过期
      state.pendingDrafts.forEach((draft) => {
        if (draft.channelId === channel.id && draft.localeId === localeId && draft.credential !== after) {
          draft.stale = true;
        }
      });

      pushLog(
        state, 'warning',
        `${locale.name}版本凭据换发，${channel.name}名额占用立即失效重算，原占用 ${windowLabel(state, previousHolder)} 需重新抢占；该语言角色确认全部失效。`
      );
    }
  });
  if (!invalidated) {
    pushLog(state, 'info', `${locale.name}正文/标题/影响范围已变动，版本凭据换发；未触达其他语言的名额与确认。`);
  }
  return state;
}

/** 语言版本递升（保留当前正文），版本号进入凭据因此同样换发并重算名额 */
export function reviseLocaleVersion(state: ScheduleState, localeId: string): void {
  const locale = state.notice.locales[localeId];
  if (!locale) return;
  const [major = 1, minor = 0] = locale.version.split('.').map(Number);
  locale.version = `${major}.${(minor || 0) + 1}.0`;
  locale.credential = credentialOf(locale.version, locale.title, locale.body, locale.scope);
  state.notice.updatedAt = new Date().toISOString();
  state.channels.forEach((channel) => {
    const slot = state.slots[slotKey(channel.id, localeId)];
    if (slot?.holderWindowId && slot.credential !== locale.credential) {
      const previousHolder = slot.holderWindowId;
      slot.holderWindowId = null;
      slot.holderOperator = '';
      slot.credential = '';
      slot.version = '';
      slot.updatedAt = new Date().toISOString();
      state.confirmations = state.confirmations.filter(
        (item) => !(item.channelId === channel.id && item.localeId === localeId)
      );
      state.pendingDrafts.forEach((draft) => {
        if (draft.channelId === channel.id && draft.localeId === localeId) draft.stale = true;
      });
      pushLog(state, 'warning', `${locale.name}版本递升至 ${locale.version}，${channel.name}名额与角色确认立即失效重算，原占用 ${windowLabel(state, previousHolder)} 需重新抢占。`);
    }
  });
}

/** 单个值班窗口抢占某渠道的某语言名额 */
export function grabSlot(state: ScheduleState, windowId: string, channelId: string, localeId: string): GrabResult {
  const channel = findChannel(state, channelId);
  const window = findWindow(state, windowId);
  const locale = state.notice.locales[localeId];
  if (!channel || !window || !locale) return { ok: false, reason: 'unauthorized' };

  // 值班员越权提交别的渠道 → 拒绝
  if (!isAuthorized(channel, windowId)) {
    pushLog(state, 'danger', `${window.name}·${window.operator} 越权提交「${channel.name}」渠道，已拒绝（该渠道未授权本窗口）。`);
    return { ok: false, reason: 'unauthorized' };
  }

  const slot = getSlot(state, channelId, localeId);
  const baseRevisions = { ...slot.revisions };

  // 断网：抢占进入待发队列，不动用中心名额
  if (!window.online) {
    state.outbox.push({
      id: uid('change'), windowId, channelId, localeId, type: 'grab',
      baseRevisions, credential: locale.credential, version: locale.version,
      createdAt: new Date().toISOString()
    });
    pushLog(state, 'info', `${window.name}处于断网，抢占「${channel.name}·${locale.name}」进入本地交接包，联网后合并。`);
    return { ok: true, reason: 'offline', slotKey: slotKey(channelId, localeId) };
  }

  const displacedWindowId = slot.holderWindowId;
  const displacedOperator = slot.holderOperator;

  // 抢占同一渠道名额：只有一人成功；盖掉旧排期
  slot.holderWindowId = windowId;
  slot.holderOperator = window.operator;
  slot.credential = locale.credential;
  slot.version = locale.version;
  slot.revisions[windowId] += 1;
  slot.updatedAt = new Date().toISOString();

  // 旧凭据上的角色确认随新占用一并失效
  state.confirmations = state.confirmations.filter(
    (item) => !(item.channelId === channelId && item.localeId === localeId)
  );

  if (displacedWindowId && displacedWindowId !== windowId) {
    // 失败方（被盖掉的旧排期）留下待处理稿并显示接管人
    state.pendingDrafts.unshift({
      id: uid('pending'), channelId, localeId,
      windowId: displacedWindowId, operator: displacedOperator,
      credential: locale.credential, version: locale.version,
      reason: 'displaced',
      takeoverWindowId: windowId, takeoverOperator: window.operator,
      createdAt: new Date().toISOString(), handled: false,
      stale: false
    });
    pushLog(
      state, 'warning',
      `${window.name}·${window.operator} 抢占「${channel.name}·${locale.name}」成功，盖掉旧排期；${windowLabel(state, displacedWindowId)} 抢占失败，已留待处理稿，接管人：${window.operator}。`
    );
  } else {
    pushLog(state, 'success', `${window.name}·${window.operator} 占用「${channel.name}·${locale.name}」名额（凭据 ${locale.credential.slice(-5)}）。`);
  }
  return { ok: true, slotKey: slotKey(channelId, localeId), displacedWindowId };
}

/** 两个值班窗口同时抢占同一渠道：只能一人成功，失败方留待处理稿并显示接管人 */
export function raceGrab(
  state: ScheduleState, channelId: string, localeId: string, windowIds: [string, string]
): RaceResult {
  const channel = findChannel(state, channelId);
  const locale = state.notice.locales[localeId];
  const slotKeyText = slotKey(channelId, localeId);
  if (!channel || !locale) {
    return { winnerWindowId: null, rejected: [], pendingDraftIds: [], slotKey: slotKeyText };
  }
  const rejected: Array<{ windowId: string; reason: string }> = [];
  const contenders: DutyWindow[] = [];
  windowIds.forEach((windowId) => {
    const window = findWindow(state, windowId);
    if (!window) return;
    if (!isAuthorized(channel, windowId)) {
      rejected.push({ windowId, reason: '越权：该渠道未授权本窗口' });
      pushLog(state, 'danger', `同时抢占中，${window.name}·${window.operator} 对「${channel.name}」越权提交，已拒绝。`);
    } else if (!window.online) {
      rejected.push({ windowId, reason: '当前断网，不能参与同时抢占' });
    } else {
      contenders.push(window);
    }
  });

  if (!contenders.length) {
    pushLog(state, 'danger', `两个值班窗口同时抢占「${channel.name}·${locale.name}」：均未通过，名额未分配。`);
    return { winnerWindowId: null, rejected, pendingDraftIds: [], slotKey: slotKeyText };
  }

  // 同一时刻只能一人成功：随机但确定地选一名赢家
  const winner = contenders[Math.floor(Math.random() * contenders.length)];
  const loser = contenders.find((window) => window.id !== winner.id) ?? null;
  const slot = getSlot(state, channelId, localeId);
  const previousHolder = slot.holderWindowId;
  const previousOperator = slot.holderOperator;

  slot.holderWindowId = winner.id;
  slot.holderOperator = winner.operator;
  slot.credential = locale.credential;
  slot.version = locale.version;
  slot.revisions[winner.id] += 1;
  slot.updatedAt = new Date().toISOString();
  state.confirmations = state.confirmations.filter(
    (item) => !(item.channelId === channelId && item.localeId === localeId)
  );

  const pendingDraftIds: string[] = [];

  // 同时抢占的失败方留待处理稿，显示接管人
  if (loser) {
    const loserDraft: PendingDraft = {
      id: uid('pending'), channelId, localeId,
      windowId: loser.id, operator: loser.operator,
      credential: locale.credential, version: locale.version,
      reason: 'race-lost',
      takeoverWindowId: winner.id, takeoverOperator: winner.operator,
      createdAt: new Date().toISOString(), handled: false, stale: false
    };
    state.pendingDrafts.unshift(loserDraft);
    pendingDraftIds.push(loserDraft.id);
  }

  // 被盖掉的旧排期同样留待处理稿（若旧占用者既不是赢家也已经是输家）
  if (previousHolder && previousHolder !== winner.id) {
    const alreadyPending = pendingDraftIds.length
      && state.pendingDrafts[0].windowId === previousHolder;
    if (!alreadyPending) {
      const displacedDraft: PendingDraft = {
        id: uid('pending'), channelId, localeId,
        windowId: previousHolder, operator: previousOperator,
        credential: locale.credential, version: locale.version,
        reason: 'displaced',
        takeoverWindowId: winner.id, takeoverOperator: winner.operator,
        createdAt: new Date().toISOString(), handled: false, stale: false
      };
      state.pendingDrafts.unshift(displacedDraft);
      pendingDraftIds.push(displacedDraft.id);
    }
  }

  pushLog(
    state, 'warning',
    `两个值班窗口同时抢占「${channel.name}·${locale.name}」：${winner.name}·${winner.operator} 成功`
      + (loser ? `；${loser.name}·${loser.operator} 失败，留待处理稿，接管人 ${winner.operator}` : '') + '。'
  );
  return { winnerWindowId: winner.id, rejected, pendingDraftIds, slotKey: slotKeyText };
}

/** 释放名额（仅本窗口可释放自己占用的渠道） */
export function releaseSlotAction(state: ScheduleState, windowId: string, channelId: string, localeId: string): void {
  const channel = findChannel(state, channelId);
  const slot = state.slots[slotKey(channelId, localeId)];
  if (!channel || !slot?.holderWindowId) return;
  if (!isAuthorized(channel, windowId)) {
    pushLog(state, 'danger', `${windowLabel(state, windowId)} 越权释放「${channel.name}」，已拒绝。`);
    return;
  }
  releaseSlot(state, slot, windowId, `${windowLabel(state, windowId)} 释放「${channel.name}·${state.notice.locales[localeId]?.name}」名额`);
}

/** 角色确认：只能由当前占用渠道的窗口作出，且绑定当前凭据 */
export function confirmRole(
  state: ScheduleState, windowId: string, channelId: string, localeId: string,
  role: RoleKey, roleName: string, owner: string
): boolean {
  const channel = findChannel(state, channelId);
  const slot = state.slots[slotKey(channelId, localeId)];
  if (!channel || !slot?.holderWindowId) return false;
  if (slot.holderWindowId !== windowId) {
    pushLog(state, 'danger', `${windowLabel(state, windowId)} 未占用「${channel.name}」，角色确认被拒绝。`);
    return false;
  }
  if (!slotCredentialValid(state, slot)) {
    pushLog(state, 'warning', `「${channel.name}·${localeId}」凭据已失效，角色确认前请重新抢占。`);
    return false;
  }
  ensureSlotConfirmed(state, slot, role, roleName, owner);
  pushLog(state, 'success', `${channel.name}·${state.notice.locales[localeId]?.name}：${roleName}（${owner}）已按当前凭据确认。`);
  return true;
}

export function markPendingHandled(state: ScheduleState, draftId: string): void {
  const draft = state.pendingDrafts.find((item) => item.id === draftId);
  if (draft) {
    draft.handled = true;
    pushLog(state, 'info', '一条待处理稿已标记处理完成。');
  }
}

export function resolveConflict(state: ScheduleState, conflictId: string, resolution: ConflictResolution): void {
  const conflict = state.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolution !== 'pending') return;
  const slot = getSlot(state, conflict.channelId, conflict.localeId);
  const locale = state.notice.locales[conflict.localeId];

  if (resolution === 'keep-local' && conflict.localChange) {
    const window = findWindow(state, conflict.localWindowId);
    slot.holderWindowId = conflict.localWindowId;
    slot.holderOperator = window?.operator ?? '';
    slot.credential = locale?.credential ?? conflict.localChange.credential;
    slot.version = conflict.localChange.version;
    slot.revisions[conflict.localWindowId] += 1;
    slot.updatedAt = new Date().toISOString();
  } else if (resolution === 'keep-remote' && conflict.remoteChange) {
    const window = findWindow(state, conflict.remoteWindowId);
    slot.holderWindowId = conflict.remoteWindowId;
    slot.holderOperator = window?.operator ?? '';
    slot.credential = locale?.credential ?? conflict.remoteChange.credential;
    slot.version = conflict.remoteChange.version;
    slot.revisions[conflict.remoteWindowId] += 1;
    slot.updatedAt = new Date().toISOString();
  }
  conflict.resolution = resolution;
  // 待决项已决：对应本地待发改动无论采用哪一边都不再重放，避免恢复联网时重复冲突
  if (conflict.localChange) {
    state.outbox = state.outbox.filter((change) => change.id !== conflict.localChange!.id);
  }
  state.confirmations = state.confirmations.filter(
    (item) => !(item.channelId === conflict.channelId && item.localeId === conflict.localeId)
  );
  pushLog(
    state, resolution === 'keep-local' ? 'success' : 'warning',
    `「${findChannel(state, conflict.channelId)?.name}·${locale?.name}」待决项已处理：采用${resolution === 'keep-local' ? '本地' : '交接包'}排期。`
  );
}

export function pendingConflicts(state: ScheduleState): SlotConflict[] {
  return state.conflicts.filter((conflict) => conflict.resolution === 'pending');
}

/** 应用一条单端写入（合并成功路径），返回旧占用窗口（用于给被盖方留稿） */
function applyRemoteChange(state: ScheduleState, change: OutboxChange): string | null {
  const slot = getSlot(state, change.channelId, change.localeId);
  if (change.type === 'release') {
    const previous = slot.holderWindowId;
    if (slot.holderWindowId === change.windowId) {
      slot.holderWindowId = null;
      slot.holderOperator = '';
      slot.credential = '';
      slot.version = '';
    }
    slot.revisions[change.windowId] += 1;
    return previous;
  }
  const previous = slot.holderWindowId;
  const window = findWindow(state, change.windowId);
  // 交接包到达后以通知当前版本凭据为准
  const locale = state.notice.locales[change.localeId];
  slot.holderWindowId = change.windowId;
  slot.holderOperator = window?.operator ?? '交接方';
  slot.credential = locale?.credential ?? change.credential;
  slot.version = locale?.version ?? change.version;
  slot.revisions[change.windowId] += 1;
  slot.updatedAt = new Date().toISOString();
  state.confirmations = state.confirmations.filter(
    (item) => !(item.channelId === change.channelId && item.localeId === change.localeId)
  );
  return previous && previous !== change.windowId ? previous : null;
}

/**
 * 断网交接包合并：按通知和版本归并；同一渠道两边都改 → 列待决项，处理前不能发布。
 * incomingChanges 来自交接包（远端窗口），localChanges 为本地待发队列。
 */
export function mergeHandover(state: ScheduleState, pkg: HandoverPackage): SlotConflict[] {
  const incomingChanges = pkg.changes;
  if (!incomingChanges.length) {
    pushLog(state, 'info', '交接包中没有需要合并的远端改动。');
    return [];
  }

  // 通知按 id + 版本归并；版本不一致先提示，仍按当前通知凭据比对
  if (pkg.notice.id === state.notice.id && pkg.notice.version !== state.notice.version) {
    pushLog(state, 'warning', `交接包通知版本 ${pkg.notice.version} 与当前 ${state.notice.version} 不一致，名额凭据以当前版本重新校验。`);
  }

  const createdConflicts: SlotConflict[] = [];

  incomingChanges.forEach((remote) => {
    // 断网交接包按通知和版本合并：同一渠道两边都改 → 列待决项
    const slot = getSlot(state, remote.channelId, remote.localeId);
    const local = state.outbox.find(
      (item) => item.channelId === remote.channelId
        && item.localeId === remote.localeId
        && item.windowId !== remote.windowId
    );
    const centerTakenByOther = !!slot.holderWindowId && slot.holderWindowId !== remote.windowId;
    const bothChanged = !!local || centerTakenByOther;

    if (bothChanged) {
      const exists = state.conflicts.find(
        (item) => item.channelId === remote.channelId
          && item.localeId === remote.localeId
          && item.resolution === 'pending'
      );
      if (!exists) {
        const conflict: SlotConflict = {
          id: uid('conflict'),
          channelId: remote.channelId, localeId: remote.localeId,
          noticeId: state.notice.id, version: state.notice.version,
          localWindowId: local?.windowId ?? slot.holderWindowId ?? pkg.exportedByWindowId,
          remoteWindowId: remote.windowId,
          localChange: local ?? null, remoteChange: remote,
          resolution: 'pending', createdAt: new Date().toISOString()
        };
        state.conflicts.unshift(conflict);
        createdConflicts.push(conflict);
        pushLog(
          state, 'danger',
          `「${findChannel(state, remote.channelId)?.name}·${state.notice.locales[remote.localeId]?.name}」同一渠道两边都改，列入待决项；处理前不能发布。`
        );
      }
    } else {
      const displaced = applyRemoteChange(state, remote);
      if (displaced) {
        const window = findWindow(state, remote.windowId);
        state.pendingDrafts.unshift({
          id: uid('pending'), channelId: remote.channelId, localeId: remote.localeId,
          windowId: displaced, operator: slot.holderOperator,
          credential: state.notice.locales[remote.localeId]?.credential ?? remote.credential,
          version: remote.version, reason: 'conflict-remote',
          takeoverWindowId: remote.windowId, takeoverOperator: window?.operator ?? '交接方',
          createdAt: new Date().toISOString(), handled: false, stale: false
        });
        pushLog(
          state, 'warning',
          `交接包改动生效：${windowLabel(state, remote.windowId)} 接管「${findChannel(state, remote.channelId)?.name}·${state.notice.locales[remote.localeId]?.name}」，原占用方留待处理稿。`
        );
      } else {
        pushLog(state, 'success', `交接包改动已合并：${windowLabel(state, remote.windowId)} 写入「${findChannel(state, remote.channelId)?.name}」。`);
      }
    }
  });

  return createdConflicts;
}

/** 窗口恢复联网：先与中心合并本地待发队列，清掉已应用条目 */
export function flushOutbox(state: ScheduleState, windowId: string): SlotConflict[] {
  const mine = state.outbox.filter((change) => change.windowId === windowId);
  if (!mine.length) return [];
  const conflicts: SlotConflict[] = [];
  const consumed: string[] = [];
  mine.forEach((change) => {
    const slot = getSlot(state, change.channelId, change.localeId);
    const holder = slot.holderWindowId;
    if (holder && holder !== windowId) {
      const conflict: SlotConflict = {
        id: uid('conflict'),
        channelId: change.channelId, localeId: change.localeId,
        noticeId: state.notice.id, version: state.notice.version,
        localWindowId: windowId, remoteWindowId: holder,
        localChange: change, remoteChange: null,
        resolution: 'pending', createdAt: new Date().toISOString()
      };
      state.conflicts.unshift(conflict);
      conflicts.push(conflict);
      pushLog(state, 'danger', `恢复联网时「${findChannel(state, change.channelId)?.name}·${state.notice.locales[change.localeId]?.name}」已被 ${windowLabel(state, holder)} 占用，列入待决项。`);
    } else {
      const result = grabSlot(state, windowId, change.channelId, change.localeId);
      if (result.ok && result.reason !== 'offline') consumed.push(change.id);
    }
  });
  state.outbox = state.outbox.filter((change) => !consumed.includes(change.id));
  return conflicts;
}

export function exportHandoverPackage(state: ScheduleState, windowId: string): HandoverPackage {
  const window = findWindow(state, windowId);
  const pkg: HandoverPackage = {
    kind: 'flood-handoff',
    exportedAt: new Date().toISOString(),
    exportedByWindowId: windowId,
    notice: JSON.parse(JSON.stringify(state.notice)),
    changes: state.outbox.filter((change) => change.windowId === windowId)
  };
  pushLog(state, 'info', `${window ? window.name : windowId} 导出断网交接包，含 ${pkg.changes.length} 条本地改动。`);
  return pkg;
}

/** 交接发布：凭据必须有效、角色确认齐全、无待决项 */
export function publishableReasons(state: ScheduleState): string[] {
  const reasons: string[] = [];
  if (pendingConflicts(state).length) {
    reasons.push(`存在 ${pendingConflicts(state).length} 项同渠道两边改动的待决项，处理前不能发布。`);
  }
  const requiredRoles: Array<{ role: RoleKey; name: string }> = [
    { role: 'duty-lead', name: '值班长' },
    { role: 'channel-auditor', name: '渠道审核' }
  ];
  state.notice.requiredLocaleIds.forEach((localeId) => {
    const locale = state.notice.locales[localeId];
    if (!locale) {
      reasons.push(`必需语言 ${localeId} 版本缺失。`);
      return;
    }
    const occupied = state.channels.filter((channel) => {
      const slot = state.slots[slotKey(channel.id, localeId)];
      return slot?.holderWindowId;
    });
    if (!occupied.length) reasons.push(`${locale.name}未占用任何渠道名额。`);
    occupied.forEach((channel) => {
      const slot = state.slots[slotKey(channel.id, localeId)];
      if (slot.credential !== locale.credential) {
        reasons.push(`${channel.name}·${locale.name}名额凭据已失效（正文/标题/影响范围变动后未重新抢占）。`);
      }
      requiredRoles.forEach(({ role, name }) => {
        const confirmation = state.confirmations.find(
          (item) => item.channelId === channel.id && item.localeId === localeId && item.role === role
        );
        if (!confirmation) {
          reasons.push(`${channel.name}·${locale.name}缺少${name}确认。`);
        } else if (confirmation.credential !== locale.credential) {
          reasons.push(`${channel.name}·${locale.name}的${name}确认绑定旧凭据，已失效需重确认。`);
        }
      });
    });
  });
  return reasons;
}

export function publish(state: ScheduleState, windowId: string, channelId: string, localeId: string): boolean {
  const reasons = publishableReasons(state).filter((reason) => reason.includes(findChannel(state, channelId)?.name ?? '___'));
  const globalBlocked = pendingConflicts(state).length
    || state.notice.requiredLocaleIds.some((id) => !state.notice.locales[id]);
  if (globalBlocked || reasons.length) {
    pushLog(state, 'danger', `交接发布被阻断：${(globalBlocked ? publishableReasons(state)[0] : reasons[0])}`);
    return false;
  }
  const slot = state.slots[slotKey(channelId, localeId)];
  const locale = state.notice.locales[localeId];
  if (!slot?.holderWindowId || slot.credential !== locale.credential) return false;
  state.publishes.unshift({
    id: uid('publish'), noticeId: state.notice.id, channelId, localeId,
    windowId, operator: slot.holderOperator,
    version: slot.version, credential: slot.credential,
    publishedAt: new Date().toISOString()
  });
  pushLog(state, 'success', `交接发布成功：${findChannel(state, channelId)?.name}·${locale.name} 版本 ${slot.version}（凭据 ${slot.credential.slice(-5)}），发布人 ${slot.holderOperator}。`);
  return true;
}

export function setOnline(state: ScheduleState, windowId: string, online: boolean): SlotConflict[] {
  const window = findWindow(state, windowId);
  if (!window) return [];
  window.online = online;
  if (online) {
    pushLog(state, 'info', `${window.name}恢复联网，开始合并本地交接包。`);
    return flushOutbox(state, windowId);
  }
  pushLog(state, 'warning', `${window.name}进入断网值班，抢占写入本地交接包。`);
  return [];
}
