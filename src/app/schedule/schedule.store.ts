import { Injectable, signal } from '@angular/core';
import {
  ConflictResolution, HandoverPackage, RoleKey, ScheduleState
} from './schedule.types';
import {
  confirmRole, editLocale, exportHandoverPackage,
  grabSlot, markPendingHandled, mergeHandover, publish, publishableReasons,
  raceGrab, releaseSlotAction, resolveConflict, reviseLocaleVersion, setOnline,
  slotCredentialValid, slotKey
} from './schedule.engine';
import { seedState } from './schedule.seed';

const STORAGE_KEY = 'sologsb-1025-flood-schedule-v1';

const ROLE_NAMES: Record<RoleKey, string> = {
  'duty-lead': '值班长',
  'channel-auditor': '渠道审核'
};

@Injectable({ providedIn: 'root' })
export class ScheduleStore {
  readonly state = signal<ScheduleState>(this.load());

  readonly roleNames = ROLE_NAMES;

  snapshot(): ScheduleState {
    return this.state();
  }

  private mutate(fn: (state: ScheduleState) => void): ScheduleState {
    const next: ScheduleState = JSON.parse(JSON.stringify(this.state()));
    fn(next);
    next.notice.updatedAt = new Date().toISOString();
    this.state.set(next);
    this.persist(next);
    return next;
  }

  /** 编辑语言版本：正文/标题/影响范围变动 → 该语言名额与角色确认立即失效重算 */
  editLocale(localeId: string, patch: { title?: string; body?: string; scope?: string }): void {
    this.mutate((state) => editLocale(state, localeId, patch));
  }

  bumpLocaleVersion(localeId: string): void {
    this.mutate((state) => reviseLocaleVersion(state, localeId));
  }

  grab(windowId: string, channelId: string, localeId: string) {
    let result: ReturnType<typeof grabSlot> = { ok: false };
    this.mutate((state) => { result = grabSlot(state, windowId, channelId, localeId); });
    return result;
  }

  race(channelId: string, localeId: string) {
    let result: ReturnType<typeof raceGrab> = {
      winnerWindowId: null, rejected: [], pendingDraftIds: [], slotKey: slotKey(channelId, localeId)
    };
    this.mutate((state) => { result = raceGrab(state, channelId, localeId, ['window-a', 'window-b']); });
    return result;
  }

  release(windowId: string, channelId: string, localeId: string): void {
    this.mutate((state) => releaseSlotAction(state, windowId, channelId, localeId));
  }

  confirm(windowId: string, channelId: string, localeId: string, role: RoleKey, owner: string): void {
    this.mutate((state) => confirmRole(state, windowId, channelId, localeId, role, ROLE_NAMES[role], owner));
  }

  handlePending(draftId: string): void {
    this.mutate((state) => markPendingHandled(state, draftId));
  }

  resolveConflict(conflictId: string, resolution: ConflictResolution): void {
    this.mutate((state) => resolveConflict(state, conflictId, resolution));
  }

  setOnline(windowId: string, online: boolean): void {
    this.mutate((state) => setOnline(state, windowId, online));
  }

  exportPackage(windowId: string): HandoverPackage {
    return exportHandoverPackage(this.state(), windowId);
  }

  importPackage(pkg: HandoverPackage): number {
    let created = 0;
    this.mutate((state) => {
      created = mergeHandover(state, pkg).length;
    });
    return created;
  }

  publish(windowId: string, channelId: string, localeId: string): boolean {
    let ok = false;
    this.mutate((state) => { ok = publish(state, windowId, channelId, localeId); });
    return ok;
  }

  publishBlockers(): string[] {
    return publishableReasons(this.state());
  }

  slotValid(channelId: string, localeId: string): boolean {
    const slot = this.state().slots[slotKey(channelId, localeId)];
    return !!slot && slotCredentialValid(this.state(), slot) && !!slot.holderWindowId;
  }

  resetDemo(): void {
    const seeded = seedState();
    this.state.set(seeded);
    this.persist(seeded);
  }

  private persist(state: ScheduleState): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 无痕模式或存储被禁用时，内存中的演示状态仍可继续
    }
  }

  private load(): ScheduleState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as ScheduleState;
        if (parsed.notice?.id && Array.isArray(parsed.channels) && Array.isArray(parsed.windows)) {
          return parsed;
        }
      }
    } catch {
      // 存储不可用时落到种子数据
    }
    const seeded = seedState();
    this.persist(seeded);
    return seeded;
  }
}
