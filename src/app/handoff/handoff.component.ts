import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  NbAlertModule, NbBadgeModule, NbButtonModule, NbCardModule, NbCheckboxModule, NbIconModule, NbInputModule,
  NbOptionModule, NbSelectModule, NbToastrService
} from '@nebular/theme';
import { HandoffService } from './handoff.service';
import { CONFIRM_ROLES, HandoffPackage, Ledger, PublishBlocker, Result, SlotClaim } from './handoff.model';

interface ClaimRow extends SlotClaim {
  channelName: string;
  localeName: string;
  stale: boolean;
  windowName: string;
}

@Component({
  selector: 'app-handoff',
  standalone: true,
  imports: [
    CommonModule, FormsModule, NbCardModule, NbButtonModule, NbInputModule, NbSelectModule, NbOptionModule,
    NbCheckboxModule, NbIconModule, NbBadgeModule, NbAlertModule
  ],
  templateUrl: './handoff.component.html',
  styleUrl: './handoff.component.scss'
})
export class HandoffComponent implements OnInit {
  readonly confirmRoles = CONFIRM_ROLES;
  readonly allLocales = [
    { id: 'zh-CN', name: '简体中文' },
    { id: 'en', name: 'English' },
    { id: 'ja', name: '日本語' }
  ];

  ledger!: Ledger;
  offline = false;
  private subs = new Subscription();

  // 抢占表单
  activeWindowId = 'win-day';
  acquireChannelId = 'sms';
  acquireLocale = 'zh-CN';
  useStaleCredential = false;

  // 内容凭据表单
  editLocale = 'zh-CN';
  editTitle = '';
  editBody = '';
  editScope = '';
  scopeChangeAll = false;

  mergeSummaryText = '';

  constructor(
    readonly handoff: HandoffService,
    private readonly toastr: NbToastrService
  ) {}

  ngOnInit(): void {
    this.subs.add(this.handoff.ledger$.subscribe((ledger) => {
      this.ledger = ledger;
    }));
    this.subs.add(this.handoff.offline$.subscribe((value) => (this.offline = value)));
    this.syncEditForm();
  }

  get noticeVersion() {
    return this.ledger.notices[this.handoff.noticeId].versions[this.handoff.version];
  }

  get contentRev(): number {
    return this.noticeVersion.contentRev;
  }

  get windows() {
    return this.ledger.windows;
  }

  get channels() {
    return this.ledger.channels;
  }

  get requiredLocales(): string[] {
    return this.noticeVersion.requiredLocales;
  }

  validLocaleClaims(locale: string): SlotClaim[] {
    return this.ledger.claims.filter(
      (c) => c.locale === locale && c.valid && c.version === this.handoff.version && c.contentRev === this.contentRev
    );
  }

  get activeWindow() {
    return this.ledger.windows.find((w) => w.id === this.activeWindowId) ?? this.ledger.windows[0];
  }

  localeName(id: string): string {
    return this.allLocales.find((l) => l.id === id)?.name ?? id;
  }

  channelName(id: string): string {
    return this.ledger.channels.find((c) => c.id === id)?.name ?? id;
  }

  windowName(id: string): string {
    return this.ledger.windows.find((w) => w.id === id)?.name ?? id;
  }

  isAuthorized(channelId: string): boolean {
    return this.activeWindow.allowedChannelIds.includes(channelId);
  }

  get authorizedChannelText(): string {
    return this.activeWindow.allowedChannelIds.map((id) => this.channelName(id)).join('、');
  }

  isConfirmed(claim: SlotClaim, role: string): boolean {
    return claim.confirms.find((x) => x.role === role)?.status === 'confirmed';
  }

  // ---------- 渠道名额视图 ----------

  channelUsage(channelId: string): { used: number; capacity: number } {
    const capacity = this.ledger.channels.find((c) => c.id === channelId)?.capacity ?? 0;
    const used = this.ledger.claims.filter((c) => c.channelId === channelId && c.valid).length;
    return { used, capacity };
  }

  claimsOf(channelId: string): ClaimRow[] {
    return this.ledger.claims
      .filter((c) => c.channelId === channelId)
      .map((c) => ({
        ...c,
        channelName: this.channelName(c.channelId),
        localeName: this.localeName(c.locale),
        stale: c.valid && c.contentRev !== this.contentRev,
        windowName: this.windowName(c.windowId)
      }))
      .sort((a, b) => Number(b.valid) - Number(a.valid) || b.claimedAt.localeCompare(a.claimedAt));
  }

  get supersededClaims(): ClaimRow[] {
    return this.ledger.claims
      .filter((c) => !c.valid && c.version !== this.handoff.version)
      .map((c) => ({
        ...c,
        channelName: this.channelName(c.channelId),
        localeName: this.localeName(c.locale),
        stale: false,
        windowName: this.windowName(c.windowId)
      }));
  }

  get openPendingDrafts() {
    return this.ledger.pendingDrafts.filter((d) => d.status === 'open');
  }

  get openConflicts() {
    return this.ledger.conflicts;
  }

  // ---------- 抢占 / 释放 ----------

  acquire(): void {
    const result: Result<SlotClaim> = this.handoff.acquire({
      windowId: this.activeWindowId,
      channelId: this.acquireChannelId,
      locale: this.acquireLocale,
      contentRev: this.useStaleCredential ? Math.max(0, this.contentRev - 1) : this.contentRev
    });
    if (result.ok) {
      this.toastr.success(result.message, '抢占成功');
    } else if (result.pending) {
      const holder = result.pending.takeover ? `接管人：${result.pending.takeover.operator}` : '渠道名额已满';
      this.toastr.warning(`${result.message} ${holder}；失败稿已进入待处理。`, '抢占被拒');
    } else {
      this.toastr.danger(result.message, '提交被拒绝');
    }
  }

  release(claim: SlotClaim): void {
    this.handoff.release(claim.key, this.activeWindowId);
    this.toastr.info(`已释放 ${this.channelName(claim.channelId)} · ${this.localeName(claim.locale)} 名额。`, '名额释放');
  }

  confirm(claim: SlotClaim, role: string): void {
    this.handoff.confirm(claim.key, role, this.activeWindow.operator);
    this.toastr.success(`${this.activeWindow.operator} 以「${role}」完成确认。`, '角色确认');
  }

  retryDraft(draftId: string): void {
    const draft = this.ledger.pendingDrafts.find((d) => d.id === draftId);
    if (!draft) return;
    const result = this.handoff.resolveDraft(draft, 'retry');
    if ('ok' in result) {
      this.toastr.success(result.ok ? '重新抢占成功，待处理稿关闭。' : result.message, result.ok ? '接管名额' : '仍被占用');
    }
  }

  discardDraft(draftId: string): void {
    const draft = this.ledger.pendingDrafts.find((d) => d.id === draftId);
    if (draft) this.handoff.resolveDraft(draft, 'discard');
    this.toastr.info('待处理稿已放弃。', '已关闭');
  }

  // ---------- 版本凭据：内容变动 → 失效重算 ----------

  onEditLocaleChange(): void {
    this.syncEditForm();
  }

  private syncEditForm(): void {
    const version = this.ledger?.notices?.[this.handoff.noticeId]?.versions?.[this.handoff.version];
    if (!version) return;
    const content = version.locales[this.editLocale];
    this.editTitle = content?.title ?? '';
    this.editBody = content?.body ?? '';
    this.editScope = version.scope;
  }

  saveContent(scopeChangedByCheckbox: boolean): void {
    const version = this.noticeVersion;
    const current = version.locales[this.editLocale];
    const titleChanged = this.editTitle.trim() !== current.title;
    const bodyChanged = this.editBody.trim() !== current.body;
    const scopeChanged = scopeChangedByCheckbox && this.editScope.trim() !== version.scope;
    if (!titleChanged && !bodyChanged && !scopeChanged) {
      this.toastr.info('标题、正文与影响范围均未变化，凭据无需重算。', '无改动');
      return;
    }
    const { invalidatedKeys, retainedLocales } = this.handoff.update({
      scope: scopeChanged ? this.editScope.trim() : undefined,
      changes: [{
        locale: this.editLocale,
        title: titleChanged ? this.editTitle.trim() : undefined,
        body: bodyChanged ? this.editBody.trim() : undefined
      }]
    });
    const retained = retainedLocales.map((l) => this.localeName(l)).join('、') || '无';
    const touched = scopeChanged ? '全部语言（影响范围变动）' : this.localeName(this.editLocale);
    this.toastr.warning(
      `凭据升至 r${this.contentRev}。触达：${touched}；${invalidatedKeys.length} 个名额与角色确认已失效重算；未触达语言保留：${retained}。`,
      '版本凭据已更新'
    );
  }

  // ---------- 断网交接 ----------

  beginOffline(): void {
    this.handoff.beginOffline();
    this.toastr.warning('夜班窗口已带走台账副本，双方进入断网分叉。', '断网开始');
  }

  exportLocal(): void {
    const pkg = this.handoff.exportPackage(this.activeWindowId);
    if (pkg) this.toastr.success(`已导出 r${pkg.revision} 交接包（按通知+版本合并）。`, '交接包导出');
  }

  simulateRemote(): void {
    const pkg = this.handoff.buildRemotePackage();
    if (pkg) {
      this.toastr.warning('断网期间：发布席与夜班同时抢占 政务新媒体/日本語；夜班另占 社区大屏/简体中文，交接包已生成。', '断网操作完成');
    } else {
      this.toastr.danger('请先让夜班分叉（进入断网）。', '无断网副本');
    }
  }

  async onPackageSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const pkg: HandoffPackage = await this.handoff.readPackage(file);
      const result = this.handoff.importPackage(pkg);
      if ('error' in result) {
        this.toastr.danger(result.error, '导入失败');
      } else {
        const { summary } = result;
        this.mergeSummaryText = `采纳 ${summary.adoptedKeys.length} 项单边改动，待决 ${summary.conflictKeys.length} 项，合并版本 ${summary.mergedVersions.length} 个，待处理稿 ${summary.mergedDrafts} 份。`;
        if (summary.conflictKeys.length) {
          this.toastr.danger(`同一渠道两边都改：${summary.conflictKeys.length} 项待决，处理前不能发布。`, '合并出现待决项');
        } else {
          this.toastr.success(this.mergeSummaryText, '交接合并完成');
        }
      }
    } catch {
      this.toastr.danger('交接包解析失败。', '导入失败');
    } finally {
      input.value = '';
    }
  }

  resolveConflict(conflictId: string, pick: 'local' | 'remote'): void {
    this.handoff.resolveConflictItem(conflictId, pick);
    this.toastr.info(`已按${pick === 'local' ? '本地（白班）' : '对端（夜班）'}处理待决项，请重新完成角色确认。`, '待决已处理');
  }

  // ---------- 发布门禁 ----------

  get blockers(): PublishBlocker[] {
    return this.handoff.blockers('win-publisher');
  }

  publish(): void {
    const result = this.handoff.publish('win-publisher');
    if (result.ok) this.toastr.success(result.message, '交接发布成功');
    else this.toastr.danger(result.message, '发布被阻断');
  }

  get published(): boolean {
    return this.noticeVersion.published;
  }

  reset(): void {
    this.handoff.reset();
    this.mergeSummaryText = '';
    this.useStaleCredential = false;
    this.toastr.info('台账已恢复到初始演示数据。', '重置');
  }
}
