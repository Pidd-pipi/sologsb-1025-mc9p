import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  acquireSlot, confirmRole, evaluatePublish, exportHandoff, importHandoff, publish, releaseSlot,
  resolveConflict, resolvePendingDraft, updateContent
} from './handoff.engine';
import { initialHandoffLedger, NOTICE_ID } from './handoff.seed';
import {
  AcquireRequest, ContentUpdateRequest, HandoffPackage, Ledger, MergeSummary, PendingDraft, PublishBlocker, Result, SlotClaim
} from './handoff.model';

const STORAGE_KEY = 'flood-handoff-ledger-v1';
const FORK_KEY = 'flood-handoff-fork-v1';
const VERSION = '2026.10.3-2';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

@Injectable({ providedIn: 'root' })
export class HandoffService {
  readonly noticeId = NOTICE_ID;
  readonly version = VERSION;

  private ledgerSubject = new BehaviorSubject<Ledger>(this.load());
  /** 断网期间对端（夜班）带走的台账副本 */
  private fork: Ledger | null = this.loadFork();
  private offlineSubject = new BehaviorSubject<boolean>(this.fork !== null);

  ledger$ = this.ledgerSubject.asObservable();
  offline$ = this.offlineSubject.asObservable();

  get ledger(): Ledger {
    return this.ledgerSubject.value;
  }

  get isOffline(): boolean {
    return this.offlineSubject.value;
  }

  // ---------- 抢占 ----------

  acquire(req: Omit<AcquireRequest, 'noticeId' | 'version'>): Result<SlotClaim> {
    const result = acquireSlot(this.ledger, { ...req, noticeId: NOTICE_ID, version: VERSION });
    this.ledgerSubject.next(result.ledger);
    this.save();
    return result;
  }

  release(key: string, windowId: string): void {
    this.ledgerSubject.next(releaseSlot(this.ledger, key, windowId));
    this.save();
  }

  // ---------- 版本凭据：正文 / 标题 / 影响范围 ----------

  update(req: Omit<ContentUpdateRequest, 'noticeId' | 'version'>): { invalidatedKeys: string[]; retainedLocales: string[] } {
    const { ledger, summary } = updateContent(this.ledger, { ...req, noticeId: NOTICE_ID, version: VERSION });
    this.ledgerSubject.next(ledger);
    this.save();
    return { invalidatedKeys: summary.invalidatedKeys, retainedLocales: summary.retainedLocales };
  }

  // ---------- 角色确认 ----------

  confirm(key: string, role: string, by: string): void {
    this.ledgerSubject.next(confirmRole(this.ledger, key, role, by));
    this.save();
  }

  // ---------- 待处理稿 ----------

  resolveDraft(draft: PendingDraft, action: 'discard' | 'retry'): Result<SlotClaim> | { ledger: Ledger } {
    const result = resolvePendingDraft(this.ledger, draft.id, action);
    this.ledgerSubject.next(result.ledger);
    this.save();
    return result;
  }

  // ---------- 发布 ----------

  blockers(windowId: string): PublishBlocker[] {
    return evaluatePublish(this.ledger, windowId, NOTICE_ID, VERSION);
  }

  publish(windowId: string): Result<{ blockers: PublishBlocker[] }> {
    const result = publish(this.ledger, windowId, NOTICE_ID, VERSION);
    this.ledgerSubject.next(result.ledger);
    this.save();
    return result;
  }

  // ---------- 待决项 ----------

  resolveConflictItem(conflictId: string, pick: 'local' | 'remote'): void {
    this.ledgerSubject.next(resolveConflict(this.ledger, conflictId, pick));
    this.save();
  }

  // ---------- 断网交接 ----------

  /** 进入断网：对端从当前台账分叉带走副本 */
  beginOffline(): void {
    this.fork = clone(this.ledger);
    this.offlineSubject.next(true);
    this.saveFork();
  }

  endOffline(): void {
    this.fork = null;
    this.offlineSubject.next(false);
    localStorage.removeItem(FORK_KEY);
  }

  /** 导出指定窗口的交接包文件 */
  exportPackage(windowId: string): HandoffPackage | undefined {
    const pkg = exportHandoff(this.ledger, windowId);
    if (pkg) this.download(pkg, `handoff-${windowId}-r${pkg.revision}.json`);
    return pkg;
  }

  /**
   * 一键模拟断网期间双方并行操作并生成对端交接包：
   * - 本地发布席与夜班同时抢占 wechat/ja（同一渠道两边都改 → 合并待决）
   * - 夜班另抢占 screen/zh-CN（仅对端单边改动，合并时直接采纳）
   */
  buildRemotePackage(): HandoffPackage | undefined {
    if (!this.fork) return undefined;
    // 本地侧：发布席在断网后抢占 wechat/ja
    const local = acquireSlot(this.ledger, { windowId: 'win-publisher', noticeId: NOTICE_ID, version: VERSION, channelId: 'wechat', locale: 'ja', contentRev: this.currentContentRevOn(this.ledger) });
    if (local.ok) this.ledgerSubject.next(local.ledger);

    // 对端侧：夜班在分叉副本上抢占同一 wechat/ja，外加 screen/zh-CN
    let remote = this.fork;
    const r1 = acquireSlot(remote, { windowId: 'win-night', noticeId: NOTICE_ID, version: VERSION, channelId: 'wechat', locale: 'ja', contentRev: this.currentContentRevOn(remote) });
    remote = r1.ledger;
    const r2 = acquireSlot(remote, { windowId: 'win-night', noticeId: NOTICE_ID, version: VERSION, channelId: 'screen', locale: 'zh-CN', contentRev: this.currentContentRevOn(remote) });
    remote = r2.ledger;
    this.fork = remote;
    this.saveFork();
    this.save();
    const pkg = exportHandoff(remote, 'win-night');
    if (pkg) this.download(pkg, `handoff-win-night-r${pkg.revision}.json`);
    return pkg;
  }

  importPackage(pkg: HandoffPackage): { summary: MergeSummary } | { error: string } {
    if (!pkg || pkg.kind !== 'flood-handoff-v1') return { error: '交接包格式不正确。' };
    const { ledger, summary } = importHandoff(this.ledger, pkg);
    this.ledgerSubject.next(ledger);
    this.save();
    return { summary };
  }

  /** 读取交接包文件 */
  async readPackage(file: File): Promise<HandoffPackage> {
    const text = await file.text();
    return JSON.parse(text) as HandoffPackage;
  }

  reset(): void {
    const fresh = initialHandoffLedger();
    this.ledgerSubject.next(fresh);
    this.endOffline();
    this.save();
  }

  // ---------- 持久化 ----------

  private currentContentRevOn(ledger: Ledger): number {
    return ledger.notices[NOTICE_ID]?.versions[VERSION]?.contentRev ?? 0;
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.ledger));
  }

  private load(): Ledger {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as Ledger;
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    return initialHandoffLedger();
  }

  private saveFork(): void {
    if (this.fork) localStorage.setItem(FORK_KEY, JSON.stringify(this.fork));
  }

  private loadFork(): Ledger | null {
    const raw = localStorage.getItem(FORK_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Ledger;
    } catch {
      return null;
    }
  }

  private download(pkg: HandoffPackage, filename: string): void {
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
