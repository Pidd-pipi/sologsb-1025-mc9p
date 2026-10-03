// 汛期渠道交接发布 · 规则引擎（纯函数，围绕 Ledger 修订号推进）
import {
  AcquireRequest,
  AuditEntry,
  ConflictItem,
  CONFIRM_ROLES,
  ContentUpdateRequest,
  ContentUpdateSummary,
  DenyReason,
  HandoffPackage,
  Ledger,
  MergeSummary,
  NoticeVersionState,
  PendingDraft,
  PublishBlocker,
  Result,
  RoleConfirm,
  SlotClaim
} from './handoff.model';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const slotKey = (noticeId: string, version: string, channelId: string, locale: string): string =>
  `${noticeId}|${version}|${channelId}|${locale}`;

function audit(ledger: Ledger, level: AuditEntry['level'], text: string, at: string): void {
  ledger.log.unshift({ id: uid('log'), at, level, text });
  if (ledger.log.length > 200) ledger.log.length = 200;
}

function touch(ledger: Ledger): void {
  ledger.revision += 1;
}

function findVersion(ledger: Ledger, noticeId: string, version: string): NoticeVersionState | undefined {
  return ledger.notices[noticeId]?.versions[version];
}

function findWindow(ledger: Ledger, windowId: string) {
  return ledger.windows.find((w) => w.id === windowId);
}

function activeClaimForKey(ledger: Ledger, key: string): SlotClaim | undefined {
  return ledger.claims.find((c) => c.key === key && c.valid);
}

function channelCapacity(ledger: Ledger, channelId: string): number {
  return ledger.channels.find((c) => c.id === channelId)?.capacity ?? 1;
}

function validClaimsOnChannel(ledger: Ledger, channelId: string): SlotClaim[] {
  return ledger.claims.filter((c) => c.channelId === channelId && c.valid);
}

function defaultConfirms(): RoleConfirm[] {
  return CONFIRM_ROLES.map((role) => ({ role, by: '', status: 'pending' }));
}

/** 拒绝时：抢占失败方留下待处理稿，并显示接管人 */
function denyWithPending(
  ledger: Ledger,
  reason: DenyReason,
  message: string,
  request: AcquireRequest,
  denyKind: 'slot-taken' | 'capacity-full',
  holder: SlotClaim | undefined,
  at: string
): Result<SlotClaim> {
  const existingOpen = ledger.pendingDrafts.find(
    (d) => d.noticeId === request.noticeId && d.version === request.version &&
      d.channelId === request.channelId && d.locale === request.locale &&
      d.windowId === request.windowId && d.status === 'open'
  );
  let pending: PendingDraft;
  if (existingOpen) {
    existingOpen.reason = denyKind;
    existingOpen.takeover = holder ? { windowId: holder.windowId, operator: holder.operator, claimedAt: holder.claimedAt } : undefined;
    pending = existingOpen;
  } else {
    pending = {
      id: uid('pending'),
      noticeId: request.noticeId,
      version: request.version,
      channelId: request.channelId,
      locale: request.locale,
      windowId: request.windowId,
      operator: findWindow(ledger, request.windowId)?.operator ?? '未知值班员',
      reason: denyKind,
      takeover: holder ? { windowId: holder.windowId, operator: holder.operator, claimedAt: holder.claimedAt } : undefined,
      note: `抢占失败：${message}`,
      createdAt: at,
      status: 'open'
    };
    ledger.pendingDrafts.unshift(pending);
  }
  return { ok: false, reason, ledger, message, pending };
}

/** 抢占渠道名额（带窗口凭据、内容凭据、乐观并发凭据） */
export function acquireSlot(input: Ledger, request: AcquireRequest, at: string = new Date().toISOString()): Result<SlotClaim> {
  const ledger = clone(input);
  const win = findWindow(ledger, request.windowId);
  if (!win) {
    return { ok: false, reason: 'window-not-found', ledger, message: '值班窗口不存在或凭据无效。' };
  }
  // 值班员越权提交别的渠道会被拒绝
  if (!win.allowedChannelIds.includes(request.channelId)) {
    audit(ledger, 'danger', `越权拦截：${win.name}（${win.operator}）试图提交未授权渠道 ${request.channelId}。`, at);
    return { ok: false, reason: 'overreach', ledger, message: `窗口「${win.name}」未获授权渠道，提交已被拒绝。` };
  }
  const versionState = findVersion(ledger, request.noticeId, request.version);
  if (!versionState) {
    return { ok: false, reason: 'notice-not-found', ledger, message: '通知版本不存在，无法抢占名额。' };
  }
  if (versionState.published) {
    return { ok: false, reason: 'already-published', ledger, message: '该版本已发布，名额不可再抢占。' };
  }
  // 版本凭据过期：正文/标题/影响范围变动后，旧凭据立即失效
  if (request.contentRev !== undefined && request.contentRev !== versionState.contentRev) {
    audit(ledger, 'warning', `${win.name} 使用旧内容凭据 r${request.contentRev}（当前 r${versionState.contentRev}）抢占被拒。`, at);
    return { ok: false, reason: 'stale-content', ledger, message: '版本凭据已失效：正文、标题或影响范围已变动，名额与确认需重算。' };
  }
  if (request.baseRevision !== undefined && request.baseRevision !== ledger.revision) {
    // 乐观锁失败按 slot-taken 处理：只允许一人成功
    const holder = activeClaimForKey(ledger, slotKey(request.noticeId, request.version, request.channelId, request.locale));
    return denyWithPending(ledger, 'slot-taken', '台账已被其他窗口更新，乐观凭据过期。', request, 'slot-taken', holder, at);
  }

  const key = slotKey(request.noticeId, request.version, request.channelId, request.locale);
  const holder = activeClaimForKey(ledger, key);
  // 抢同一位只能一人成功
  if (holder) {
    audit(ledger, 'warning', `${win.name} 抢占 ${request.channelId}/{locale} 失败：已被 ${holder.operator} 占用。`.replace('{locale}', request.locale), at);
    return denyWithPending(ledger, 'slot-taken', `该名额已由「${holder.operator}」接管。`, request, 'slot-taken', holder, at);
  }
  // 新版本排到渠道：盖掉同一渠道上同一通知的旧版本排期
  const superseded = ledger.claims.filter(
    (c) => c.valid && c.noticeId === request.noticeId && c.channelId === request.channelId && c.version !== request.version
  );
  superseded.forEach((old) => {
    old.valid = false;
    audit(ledger, 'info', `新版本 ${request.version} 抢占 ${request.channelId}：旧排期 ${old.version} · ${old.locale} 被盖掉。`, at);
  });
  // 有限渠道名额
  const occupied = validClaimsOnChannel(ledger, request.channelId);
  if (occupied.length >= channelCapacity(ledger, request.channelId)) {
    const fallback = occupied[0];
    audit(ledger, 'warning', `${win.name} 抢占 ${request.channelId} 失败：渠道名额 ${occupied.length}/${channelCapacity(ledger, request.channelId)} 已满。`, at);
    return denyWithPending(ledger, 'capacity-full', `渠道名额已满（${occupied.length}/${channelCapacity(ledger, request.channelId)}）。`, request, 'capacity-full', fallback, at);
  }

  const claim: SlotClaim = {
    key,
    noticeId: request.noticeId,
    version: request.version,
    channelId: request.channelId,
    locale: request.locale,
    windowId: request.windowId,
    operator: win.operator,
    claimedAt: at,
    contentRev: versionState.contentRev,
    ledgerRev: ledger.revision + 1,
    valid: true,
    confirms: defaultConfirms()
  };
  ledger.claims.push(claim);
  ledger.dirtyKeys = [...new Set([...ledger.dirtyKeys, key])];
  touch(ledger);
  audit(ledger, 'success', `${win.name}（${win.operator}）成功抢占 ${request.channelId} · ${request.locale}（凭据 r${claim.contentRev}）。`, at);
  return { ok: true, value: claim, ledger, message: `已占用 ${request.channelId} 的 ${request.locale} 名额。` };
}

/** 释放渠道名额 */
export function releaseSlot(input: Ledger, key: string, windowId: string, at: string = new Date().toISOString()): Ledger {
  const ledger = clone(input);
  const win = findWindow(ledger, windowId);
  const claim = ledger.claims.find((c) => c.key === key);
  if (!win || !claim) return ledger;
  if (!win.allowedChannelIds.includes(claim.channelId)) {
    audit(ledger, 'danger', `越权拦截：${win.name} 试图释放未授权渠道 ${claim.channelId} 的名额。`, at);
    return ledger;
  }
  if (claim.valid) {
    claim.valid = false;
    ledger.dirtyKeys = [...new Set([...ledger.dirtyKeys, key])];
    ledger.releases.push({ key, windowId, operator: win.operator, at });
    touch(ledger);
    audit(ledger, 'info', `${win.name} 释放 ${claim.channelId} · ${claim.locale} 名额。`, at);
  }
  return ledger;
}

/**
 * 修改通知正文/标题/影响范围：
 * - contentRev 自增；
 * - 触达语言（或影响范围变动时全部语言）的占用名额与角色确认立即失效重算；
 * - 未触达语言照常保留。
 */
export function updateContent(input: Ledger, request: ContentUpdateRequest, at: string = new Date().toISOString()): { ledger: Ledger; summary: ContentUpdateSummary } {
  const ledger = clone(input);
  const versionState = findVersion(ledger, request.noticeId, request.version);
  if (!versionState) return { ledger, summary: { contentRev: 0, scopeChanged: false, invalidatedKeys: [], retainedLocales: [] } };

  const scopeChanged = request.scope !== undefined && request.scope !== versionState.scope;
  const touchedLocales = new Set(request.changes.map((c) => c.locale));
  let changed = scopeChanged;

  if (scopeChanged) versionState.scope = request.scope as string;
  request.changes.forEach((change) => {
    const content = versionState.locales[change.locale];
    if (!content) return;
    if (change.title !== undefined && change.title !== content.title) { content.title = change.title; changed = true; }
    if (change.body !== undefined && change.body !== content.body) { content.body = change.body; changed = true; }
  });
  if (!changed) {
    return {
      ledger,
      summary: { contentRev: versionState.contentRev, scopeChanged: false, invalidatedKeys: [], retainedLocales: Object.keys(versionState.locales) }
    };
  }

  versionState.contentRev += 1;
  versionState.published = false;
  const invalidatedKeys: string[] = [];
  const retained: string[] = [];

  ledger.claims.forEach((claim) => {
    if (claim.noticeId !== request.noticeId || claim.version !== request.version || !claim.valid) return;
    const affected = scopeChanged || touchedLocales.has(claim.locale);
    if (affected) {
      claim.valid = false;
      claim.confirms = claim.confirms.map((c) => ({ ...c, status: 'pending', by: '', at: undefined }));
      invalidatedKeys.push(claim.key);
      ledger.dirtyKeys = [...new Set([...ledger.dirtyKeys, claim.key])];
    }
  });
  Object.keys(versionState.locales).forEach((locale) => {
    const retainedNow = ledger.claims.some(
      (c) => c.noticeId === request.noticeId && c.version === request.version && c.locale === locale && c.valid
    );
    if (retainedNow) retained.push(locale);
  });

  touch(ledger);
  audit(
    ledger,
    'warning',
    `${scopeChanged ? '影响范围' : '正文/标题'}变动，内容凭据升至 r${versionState.contentRev}；${invalidatedKeys.length} 个名额失效重算，未触达语言保留：${retained.join('、') || '无'}。`,
    at
  );
  return { ledger, summary: { contentRev: versionState.contentRev, scopeChanged, invalidatedKeys, retainedLocales: retained } };
}

/** 角色确认（仅限名额仍有效；名额一旦失效，确认立即作废重算） */
export function confirmRole(input: Ledger, key: string, role: string, by: string, at: string = new Date().toISOString()): Ledger {
  const ledger = clone(input);
  const claim = ledger.claims.find((c) => c.key === key);
  if (!claim || !claim.valid) return ledger;
  const item = claim.confirms.find((c) => c.role === role);
  if (!item || item.status === 'confirmed') return ledger;
  item.status = 'confirmed';
  item.by = by;
  item.at = at;
  touch(ledger);
  audit(ledger, 'success', `${claim.channelId} · ${claim.locale} 获「${role}」确认（${by}）。`, at);
  return ledger;
}

/** 待处理稿操作：放弃 或 重新抢占（接管人释放后才可成功） */
export function resolvePendingDraft(input: Ledger, pendingId: string, action: 'discard' | 'retry', at: string = new Date().toISOString()): Result<SlotClaim> | { ledger: Ledger } {
  const ledger = clone(input);
  const draft = ledger.pendingDrafts.find((d) => d.id === pendingId);
  if (!draft) return { ledger };
  if (action === 'discard') {
    draft.status = 'discarded';
    audit(ledger, 'info', `待处理稿（${draft.channelId} · ${draft.locale}）已放弃。`, at);
    return { ledger };
  }
  const res = acquireSlot(ledger, {
    windowId: draft.windowId,
    noticeId: draft.noticeId,
    version: draft.version,
    channelId: draft.channelId,
    locale: draft.locale
  }, at);
  if (res.ok) {
    const retaken = res.ledger.pendingDrafts.find((d) => d.id === pendingId);
    if (retaken) retaken.status = 'retaken';
    audit(res.ledger, 'success', `待处理稿重新抢占成功（${draft.channelId} · ${draft.locale}）。`, at);
  }
  return res;
}

/** 导出错网交接包：按通知和版本携带内容与名额 */
export function exportHandoff(input: Ledger, fromWindowId: string, at: string = new Date().toISOString()): HandoffPackage | undefined {
  const win = findWindow(input, fromWindowId);
  if (!win) return undefined;
  return {
    kind: 'flood-handoff-v1',
    fromWindowId,
    fromOperator: win.operator,
    exportedAt: at,
    forkRevision: input.syncedRevision,
    revision: input.revision,
    notices: clone(input.notices),
    claims: input.claims.filter((c) => c.windowId === fromWindowId).map(clone),
    pendingDrafts: input.pendingDrafts.filter((d) => d.windowId === fromWindowId).map(clone),
    dirtyKeys: [...input.dirtyKeys],
    releases: input.releases.filter((r) => r.windowId === fromWindowId).map(clone),
    published: Object.entries(input.notices).flatMap(([noticeId, store]) =>
      Object.values(store.versions).filter((v) => v.published && v.publishedAt).map((v) => ({ noticeId, version: v.version, at: v.publishedAt as string }))
    )
  };
}

function sameContent(a: NoticeVersionState, b: NoticeVersionState): boolean {
  return a.scope === b.scope && JSON.stringify(a.locales) === JSON.stringify(b.locales);
}

function mergeNoticeVersion(local: NoticeVersionState, incoming: NoticeVersionState): { merged: NoticeVersionState; changed: boolean } {
  // 内容按内容凭据 r 号合并：高 r 覆盖低 r；同 r 内容一致则无需变化。
  // 同 r 但两边内容不同（断网期间各自改动）由名额层面的待决项覆盖处理。
  if (incoming.contentRev > local.contentRev) return { merged: clone(incoming), changed: true };
  if (incoming.contentRev === local.contentRev && !sameContent(local, incoming)) return { merged: local, changed: false };
  return { merged: local, changed: false };
}

/**
 * 断网交接合并：
 * - 通知按 通知+版本 合并（内容凭据高者胜）；
 * - 同一渠道两边都改 → 列待决项，处理前不能发布；
 * - 一边释放、另一边仍占用 → 以释放为准，名额释放；
 * - 仅单边改动 → 直接采纳。
 */
export function importHandoff(input: Ledger, pkg: HandoffPackage, at: string = new Date().toISOString()): { ledger: Ledger; summary: MergeSummary; conflicts: ConflictItem[] } {
  const ledger = clone(input);
  const summary: MergeSummary = { adoptedKeys: [], conflictKeys: [], mergedDrafts: 0, mergedVersions: [] };

  // 1) 通知 + 版本合并
  Object.entries(pkg.notices).forEach(([noticeId, incomingStore]) => {
    const localStore = ledger.notices[noticeId] ?? { versions: {} };
    Object.entries(incomingStore.versions).forEach(([version, incomingVersion]) => {
      const localVersion = localStore.versions[version];
      if (!localVersion) {
        localStore.versions[version] = clone(incomingVersion);
        summary.mergedVersions.push(`${noticeId}@${version}`);
      } else {
        const { merged, changed } = mergeNoticeVersion(localVersion, incomingVersion);
        localStore.versions[version] = merged;
        if (changed) summary.mergedVersions.push(`${noticeId}@${version}`);
      }
    });
    ledger.notices[noticeId] = localStore;
  });

  // 2) 待处理稿按 id 合并
  pkg.pendingDrafts.forEach((draft) => {
    if (!ledger.pendingDrafts.some((d) => d.id === draft.id)) ledger.pendingDrafts.unshift(clone(draft));
  });
  summary.mergedDrafts = pkg.pendingDrafts.length;

  const localDirty = new Set(ledger.dirtyKeys);
  const remoteDirty = new Set(pkg.dirtyKeys);
  const remoteClaims = new Map(pkg.claims.map((c) => [c.key, c]));
  const remoteReleaseKeys = new Set(pkg.releases.map((r) => r.key));

  // 3) 名额合并
  const allKeys = new Set<string>([...ledger.claims.map((c) => c.key), ...pkg.claims.map((c) => c.key)]);
  allKeys.forEach((key) => {
    const localClaim = ledger.claims.find((c) => c.key === key);
    const remoteClaim = remoteClaims.get(key);
    const localTouched = localDirty.has(key);
    const remoteTouched = remoteDirty.has(key);

    // 单边释放
    if (localClaim && remoteReleaseKeys.has(key) && !localTouched) {
      localClaim.valid = false;
      summary.adoptedKeys.push(key);
      return;
    }
    if (remoteClaim && ledger.releases.some((r) => r.key === key) && !remoteTouched) {
      remoteClaim.valid = false;
    }

    if (localTouched && remoteTouched) {
      // 同一渠道两边都改 → 待决项
      if (!ledger.conflicts.some((x) => x.key === key)) {
        const conflict: ConflictItem = {
          id: uid('conflict'),
          key,
          noticeId: localClaim?.noticeId ?? remoteClaim?.noticeId ?? '',
          version: localClaim?.version ?? remoteClaim?.version ?? '',
          channelId: localClaim?.channelId ?? remoteClaim?.channelId ?? '',
          locale: localClaim?.locale ?? remoteClaim?.locale ?? '',
          local: localClaim
            ? { windowId: localClaim.windowId, operator: localClaim.operator, claimed: true, valid: localClaim.valid, contentRev: localClaim.contentRev, at: localClaim.claimedAt }
            : { windowId: ledger.windows[0]?.id ?? '', operator: '本地（已释放）', claimed: false, valid: false, contentRev: 0, at },
          remote: remoteClaim
            ? { windowId: remoteClaim.windowId, operator: remoteClaim.operator, claimed: true, valid: remoteClaim.valid, contentRev: remoteClaim.contentRev, at: remoteClaim.claimedAt }
            : { windowId: pkg.fromWindowId, operator: `${pkg.fromOperator}（已释放）`, claimed: false, valid: false, contentRev: 0, at },
          status: 'pending',
          createdAt: at
        };
        ledger.conflicts.unshift(conflict);
        summary.conflictKeys.push(key);
        if (localClaim) localClaim.valid = false; // 待决期间名额冻结，不能发布
      }
      return;
    }

    // 单边改动：远端有而本地无 → 采纳
    if (!localClaim && remoteClaim) {
      ledger.claims.push(clone(remoteClaim));
      summary.adoptedKeys.push(key);
    }
  });

  ledger.syncedRevision = ledger.revision;
  ledger.dirtyKeys = [];
  touch(ledger);
  audit(
    ledger,
    summary.conflictKeys.length ? 'danger' : 'success',
    `断网交接合并完成：采纳 ${summary.adoptedKeys.length} 项，待决 ${summary.conflictKeys.length} 项，版本合并 ${summary.mergedVersions.length} 个。`,
    at
  );
  return { ledger, summary, conflicts: ledger.conflicts };
}

/** 处理待决项：保留本地或对端 */
export function resolveConflict(input: Ledger, conflictId: string, pick: 'local' | 'remote', at: string = new Date().toISOString()): Ledger {
  const ledger = clone(input);
  const conflict = ledger.conflicts.find((c) => c.id === conflictId);
  if (!conflict) return ledger;
  const side = pick === 'local' ? conflict.local : conflict.remote;
  const existing = ledger.claims.find((c) => c.key === conflict.key);
  if (existing) {
    existing.valid = side.claimed && side.valid;
    existing.windowId = side.windowId;
    existing.operator = side.operator;
    existing.contentRev = side.contentRev;
    existing.confirms = existing.valid ? defaultConfirms() : existing.confirms;
  } else if (side.claimed) {
    ledger.claims.push({
      key: conflict.key, noticeId: conflict.noticeId, version: conflict.version, channelId: conflict.channelId, locale: conflict.locale,
      windowId: side.windowId, operator: side.operator, claimedAt: side.at, contentRev: side.contentRev, ledgerRev: ledger.revision + 1,
      valid: true, confirms: defaultConfirms()
    });
  }
  ledger.conflicts = ledger.conflicts.filter((c) => c.id !== conflictId);
  touch(ledger);
  audit(ledger, 'success', `待决项 ${conflict.channelId} · ${conflict.locale} 已按${pick === 'local' ? '本地' : '对端'}处理。`, at);
  return ledger;
}

/** 发布门禁：待决项未处理 / 凭据过期 / 缺名额 / 确认未齐 均阻断 */
export function evaluatePublish(input: Ledger, windowId: string, noticeId: string, version: string): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  const win = findWindow(input, windowId);
  if (!win) return [{ code: 'window-not-found', message: '值班窗口凭据无效。' }];
  if (!win.canPublish) blockers.push({ code: 'publish-forbidden', message: `窗口「${win.name}」无交接发布权限。` });
  const versionState = findVersion(input, noticeId, version);
  if (!versionState) return [{ code: 'notice-not-found', message: '通知版本不存在。' }];
  if (versionState.published) blockers.push({ code: 'already-published', message: '该版本已发布。' });

  const openConflicts = input.conflicts.filter((c) => c.noticeId === noticeId && c.version === version);
  if (openConflicts.length) blockers.push({ code: 'conflict-open', message: `有 ${openConflicts.length} 项断网合并待决项未处理，处理前不能发布。` });

  versionState.requiredLocales.forEach((locale) => {
    const content = versionState.locales[locale];
    if (!content || !content.title.trim() || !content.body.trim()) {
      blockers.push({ code: 'locale-content-missing', message: `${locale} 版本标题或正文缺失。` });
      return;
    }
    const claims = input.claims.filter((c) => c.noticeId === noticeId && c.version === version && c.locale === locale && c.valid);
    if (!claims.length) {
      blockers.push({ code: 'locale-claim-missing', message: `${locale} 版本尚未占用有效渠道名额。` });
      return;
    }
    claims.forEach((claim) => {
      if (claim.contentRev !== versionState.contentRev) {
        blockers.push({ code: 'claim-invalid', message: `${claim.channelId} · ${locale} 的名额凭据过期（r${claim.contentRev} ≠ r${versionState.contentRev}）。` });
      }
      if (!win.allowedChannelIds.includes(claim.channelId)) {
        blockers.push({ code: 'publish-forbidden', message: `${claim.channelId} 不在「${win.name}」授权范围。` });
      }
      const pending = claim.confirms.filter((c) => c.status !== 'confirmed');
      if (pending.length) {
        blockers.push({ code: 'confirm-pending', message: `${claim.channelId} · ${locale} 缺确认：${pending.map((c) => c.role).join('、')}。` });
      }
    });
  });
  return blockers;
}

export function publish(input: Ledger, windowId: string, noticeId: string, version: string, at: string = new Date().toISOString()): Result<{ blockers: PublishBlocker[] }> {
  const ledger = clone(input);
  const blockers = evaluatePublish(ledger, windowId, noticeId, version);
  if (blockers.length) {
    audit(ledger, 'danger', `交接发布被拒：${blockers.map((b) => b.message).join('；')}`, at);
    return { ok: false, reason: 'slot-taken', ledger, message: blockers[0].message };
  }
  const versionState = findVersion(ledger, noticeId, version);
  if (!versionState) return { ok: false, reason: 'notice-not-found', ledger, message: '通知版本不存在。' };
  versionState.published = true;
  versionState.publishedAt = at;
  touch(ledger);
  audit(ledger, 'success', `交接发布成功：${noticeId}@${version}，${versionState.requiredLocales.join('、')} 已按占用名额下发。`, at);
  return { ok: true, value: { blockers: [] }, ledger, message: '交接发布完成。' };
}
