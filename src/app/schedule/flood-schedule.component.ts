import { CommonModule } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NbAlertModule, NbBadgeModule, NbButtonModule, NbCardModule, NbCheckboxModule,
  NbIconModule, NbInputModule, NbOptionModule, NbSelectModule, NbTabsetModule,
  NbToastrService, NbToggleModule, NbTooltipModule
} from '@nebular/theme';
import { ScheduleStore } from './schedule.store';
import { shortCredential, slotKey } from './schedule.engine';
import {
  ChannelDef, GrabResult, HandoverPackage, RoleKey, ScheduleLocale, SlotState
} from './schedule.types';

@Component({
  selector: 'app-flood-schedule',
  standalone: true,
  imports: [
    CommonModule, FormsModule, NbCardModule, NbButtonModule, NbInputModule,
    NbSelectModule, NbOptionModule, NbCheckboxModule, NbIconModule, NbBadgeModule,
    NbAlertModule, NbTabsetModule, NbToggleModule, NbTooltipModule
  ],
  templateUrl: './flood-schedule.component.html',
  styleUrl: './flood-schedule.component.scss'
})
export class FloodScheduleComponent implements OnInit {
  /** 当前操作窗口（模拟值班员切换） */
  readonly activeWindowId = signal<'window-a' | 'window-b'>('window-a');
  /** 正在编辑的语言版本 */
  readonly activeLocaleId = signal<string>('zh-CN');

  // 版本编辑暂存：点击“保存并换发凭据”才触发名额与确认失效重算
  draftTitle = '';
  draftBody = '';
  draftScope = '';

  readonly roleKeys: RoleKey[] = ['duty-lead', 'channel-auditor'];

  constructor(
    readonly store: ScheduleStore,
    private readonly toastr: NbToastrService
  ) {}

  ngOnInit(): void {
    this.syncDraftEditor();
  }

  get state() {
    return this.store.state();
  }

  get localeIds(): string[] {
    return this.state.notice.requiredLocaleIds;
  }

  locale(id: string): ScheduleLocale {
    return this.state.notice.locales[id];
  }

  get activeLocale(): ScheduleLocale {
    return this.locale(this.activeLocaleId());
  }

  get activeWindow() {
    return this.state.windows.find((window) => window.id === this.activeWindowId())!;
  }

  windowName(windowId: string | null): string {
    return this.state.windows.find((window) => window.id === windowId)?.name ?? '空闲';
  }

  channel(id: string): ChannelDef {
    return this.state.channels.find((channel) => channel.id === id)!;
  }

  slot(channelId: string, localeId: string): SlotState | undefined {
    return this.state.slots[slotKey(channelId, localeId)];
  }

  isHolder(channelId: string, localeId: string, windowId: string): boolean {
    return this.slot(channelId, localeId)?.holderWindowId === windowId;
  }

  isAuthorized(channel: ChannelDef, windowId: string): boolean {
    return channel.authorizedWindows.includes(windowId);
  }

  credentialValid(channelId: string, localeId: string): boolean {
    return this.store.slotValid(channelId, localeId);
  }

  isConfirmed(channelId: string, localeId: string, role: RoleKey): boolean {
    return this.state.confirmations.some(
      (item) => item.channelId === channelId
        && item.localeId === localeId
        && item.role === role
        && item.credential === this.locale(localeId).credential
    );
  }

  slotReady(channelId: string, localeId: string): boolean {
    return this.credentialValid(channelId, localeId)
      && this.roleKeys.every((role) => this.isConfirmed(channelId, localeId, role))
      && !this.state.conflicts.some((conflict) => conflict.resolution === 'pending'
        && conflict.channelId === channelId && conflict.localeId === localeId);
  }

  get pendingConflictCount(): number {
    return this.state.conflicts.filter((conflict) => conflict.resolution === 'pending').length;
  }

  get pendingDraftCount(): number {
    return this.state.pendingDrafts.filter((draft) => !draft.handled).length;
  }

  get blockers(): string[] {
    return this.store.publishBlockers();
  }

  short(value: string): string {
    return shortCredential(value);
  }

  formatTime(value: string): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
  }

  selectLocale(localeId: string): void {
    this.activeLocaleId.set(localeId);
    this.syncDraftEditor();
  }

  syncDraftEditor(): void {
    const locale = this.activeLocale;
    this.draftTitle = locale.title;
    this.draftBody = locale.body;
    this.draftScope = locale.scope;
  }

  /** 正文、标题或影响范围保存后：凭据换发，占用名额与角色确认立即失效重算；未触达语言保留 */
  saveLocaleRevision(): void {
    const locale = this.activeLocale;
    const patch: { title?: string; body?: string; scope?: string } = {};
    if (this.draftTitle.trim() && this.draftTitle !== locale.title) patch.title = this.draftTitle;
    if (this.draftBody.trim() && this.draftBody !== locale.body) patch.body = this.draftBody;
    if (this.draftScope.trim() && this.draftScope !== locale.scope) patch.scope = this.draftScope;
    if (!Object.keys(patch).length) {
      this.toastr.info('正文、标题与影响范围均未变化。', '无改动');
      return;
    }
    this.store.editLocale(locale.id, patch);
    const hadSlot = this.state.channels.some((channel) => this.slot(channel.id, locale.id)?.holderWindowId);
    if (hadSlot) {
      this.toastr.warning(
        `${locale.name} 凭据已换发，该语言渠道名额与值班长/渠道审核确认立即失效，需重新抢占与确认；其他语言照常保留。`,
        '名额与确认已重算',
        { duration: 6000 }
      );
    } else {
      this.toastr.success(`${locale.name} 凭据已换发（该语言尚未占用名额）。`, '版本凭据已更新');
    }
  }

  bumpVersion(): void {
    this.store.bumpLocaleVersion(this.activeLocaleId());
    this.syncDraftEditor();
    this.toastr.warning(`${this.activeLocale.name} 版本号递升，旧凭据名额与角色确认失效重算。`, '版本已递升');
  }

  grab(channelId: string): void {
    const windowId = this.activeWindowId();
    const localeId = this.activeLocaleId();
    const result: GrabResult = this.store.grab(windowId, channelId, localeId);
    if (!result.ok && result.reason === 'unauthorized') {
      this.toastr.danger(
        `${this.activeWindow.name}未被授权提交「${this.channel(channelId).name}」，值班员越权提交已被拒绝。`,
        '越权提交被拒绝',
        { duration: 5000 }
      );
      return;
    }
    if (result.reason === 'offline') {
      this.toastr.info('当前断网，抢占已写入本地交接包，联网或导入对端时合并。', '已进入交接包');
      return;
    }
    if (result.displacedWindowId) {
      this.toastr.warning(
        `抢占成功并盖掉旧排期；原占用方${this.windowName(result.displacedWindowId)}已留待处理稿，接管人：${this.activeWindow.operator}。`,
        '抢占成功 · 旧排期已盖掉',
        { duration: 6000 }
      );
      return;
    }
    this.toastr.success(`已占用「${this.channel(channelId).name}·${this.activeLocale.name}」名额。`, '抢占成功');
  }

  /** 两个值班窗口同时抢占同一渠道：只能一人成功 */
  race(channelId: string): void {
    const localeId = this.activeLocaleId();
    const bothOnline = this.state.windows.every((window) => window.online);
    if (!bothOnline) {
      this.toastr.warning('两个值班窗口必须同时在线才能演示同时抢占。', '窗口未全部在线');
      return;
    }
    const result = this.store.race(channelId, localeId);
    result.rejected.forEach((item) => {
      this.toastr.danger(`${this.windowName(item.windowId)}：${item.reason}。`, '越权/无效提交被拒绝');
    });
    if (result.winnerWindowId) {
      const winner = this.state.windows.find((window) => window.id === result.winnerWindowId);
      this.toastr.show(
        result.pendingDraftIds.length
          ? `获胜：${winner?.name}·${winner?.operator}；失败方已留待处理稿并显示接管人。`
          : `获胜：${winner?.name}·${winner?.operator}。`,
        '同时抢占结果（仅一人成功）',
        { status: result.pendingDraftIds.length ? 'warning' : 'success', duration: 7000 }
      );
    }
  }

  release(channelId: string): void {
    this.store.release(this.activeWindowId(), channelId, this.activeLocaleId());
  }

  confirm(channelId: string, role: RoleKey): void {
    this.store.confirm(
      this.activeWindowId(), channelId, this.activeLocaleId(), role, this.activeWindow.operator
    );
    this.toastr.success(`${this.store.roleNames[role]}已按当前凭据确认。`, '角色确认');
  }

  publish(channelId: string): void {
    const ok = this.store.publish(this.activeWindowId(), channelId, this.activeLocaleId());
    if (ok) {
      this.toastr.success(
        `「${this.channel(channelId).name}·${this.activeLocale.name}」版本 ${this.activeLocale.version} 已带凭据交接发布。`,
        '交接发布成功'
      );
    } else {
      this.toastr.danger(this.blockers[0] ?? '名额凭据或角色确认未就绪，不能发布。', '交接发布被阻断', { duration: 6000 });
    }
  }

  toggleOnline(windowId: string, online: boolean): void {
    this.store.setOnline(windowId, online);
    if (online) this.toastr.info(`${this.windowName(windowId)}恢复联网，正在合并本地交接包。`, '恢复联网');
  }

  exportPackage(windowId: string): void {
    const pkg = this.store.exportPackage(windowId);
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `flood-handoff-${windowId}-${pkg.exportedAt.replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toastr.success(`交接包已导出（${pkg.changes.length} 条改动，按通知 ${pkg.notice.id} / 版本归并）。`, '导出交接包');
  }

  onPackageFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pkg = JSON.parse(String(reader.result)) as HandoverPackage;
        if (pkg.kind !== 'flood-handoff' || !Array.isArray(pkg.changes) || !pkg.notice) {
          this.toastr.danger('文件不是有效的汛期断网交接包。', '导入失败');
          return;
        }
        const conflicts = this.store.importPackage(pkg);
        if (conflicts) {
          this.toastr.warning(
            `合并完成：发现 ${conflicts} 个渠道两边都改，已列待决项，处理前不能发布。`,
            '交接包已合并',
            { duration: 7000 }
          );
        } else {
          this.toastr.success('交接包改动已合并，无待决项。', '交接包已合并');
        }
      } catch {
        this.toastr.danger('交接包解析失败。', '导入失败');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  resolveConflict(conflictId: string, resolution: 'keep-local' | 'keep-remote'): void {
    this.store.resolveConflict(conflictId, resolution);
  }

  handleDraft(draftId: string): void {
    this.store.handlePending(draftId);
  }

  resetDemo(): void {
    this.store.resetDemo();
    this.syncDraftEditor();
    this.toastr.info('已恢复汛期排期演示初始状态。', '重置演示');
  }

  reasonLabel(reason: string): string {
    return reason === 'race-lost' ? '同时抢占失败'
      : reason === 'displaced' ? '旧排期被盖'
      : '交接包接管';
  }

  changeType(change: { type: 'grab' | 'release' } | null): string {
    if (!change) return '';
    return change.type === 'grab' ? '抢占' : '释放';
  }

  setActiveWindow(windowId: string): void {
    this.activeWindowId.set(windowId === 'window-b' ? 'window-b' : 'window-a');
  }

  windowHasOutbox(windowId: string): boolean {
    return this.state.outbox.some((change) => change.windowId === windowId);
  }

  pendingDraftsOrConflicts(): boolean {
    return this.state.pendingDrafts.length > 0;
  }

  /** 该语言所有已占用名额凭据均有效（未占用则视为健康，不动未触达名额） */
  localeSlotsHealthy(localeId: string): boolean {
    return this.state.channels
      .map((channel) => this.slot(channel.id, localeId))
      .filter((slot): slot is SlotState => !!slot?.holderWindowId)
      .every((slot) => slot.credential === this.locale(localeId).credential);
  }
}
