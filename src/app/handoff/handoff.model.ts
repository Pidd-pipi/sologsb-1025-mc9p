// 汛期渠道交接发布 · 领域模型
// 纯 TypeScript，不依赖 Angular，便于离线推演与单元测试。

export type ActorRole = '值班员' | '发布人';

/** 有限名额渠道 */
export interface ChannelDef {
  id: string;
  name: string;
  /** 该渠道同时可承载的语言版本名额上限 */
  capacity: number;
}

/** 值班窗口（白班/夜班），只能提交被授权的渠道 */
export interface DutyWindow {
  id: string;
  name: string;
  operator: string;
  role: ActorRole;
  allowedChannelIds: string[];
  /** 是否有权限执行交接发布 */
  canPublish: boolean;
}

export interface LocaleContent {
  title: string;
  body: string;
}

/** 通知的一个语言版本凭据载体：正文/标题/影响范围任一变动都会推高 contentRev */
export interface NoticeVersionState {
  noticeId: string;
  version: string;
  scope: string;
  requiredLocales: string[];
  locales: Record<string, LocaleContent>;
  /** 内容凭据版本号：旧凭据占用的名额在其变动后立即失效 */
  contentRev: number;
  published: boolean;
  publishedAt?: string;
}

export interface NoticeStore {
  versions: Record<string, NoticeVersionState>;
}

export type ConfirmStatus = 'pending' | 'confirmed';

export interface RoleConfirm {
  role: string;
  by: string;
  at?: string;
  status: ConfirmStatus;
}

/** 渠道名额占用：同一渠道+通知+版本+语言只能存在一条有效占用 */
export interface SlotClaim {
  key: string;
  noticeId: string;
  version: string;
  channelId: string;
  locale: string;
  windowId: string;
  operator: string;
  claimedAt: string;
  /** 占用时的内容凭据 */
  contentRev: number;
  /** 占用时的台账修订号（乐观并发凭据） */
  ledgerRev: number;
  /** 内容变动后置为 false，名额释放、需要重新抢占 */
  valid: boolean;
  confirms: RoleConfirm[];
}

export type DenyReason =
  | 'window-not-found'
  | 'overreach'
  | 'notice-not-found'
  | 'already-published'
  | 'stale-content'
  | 'slot-taken'
  | 'capacity-full';

/** 抢占失败方留下的待处理稿，记录接管人 */
export interface PendingDraft {
  id: string;
  noticeId: string;
  version: string;
  channelId: string;
  locale: string;
  windowId: string;
  operator: string;
  reason: 'slot-taken' | 'capacity-full';
  takeover?: { windowId: string; operator: string; claimedAt: string };
  note: string;
  createdAt: string;
  status: 'open' | 'discarded' | 'retaken';
}

export interface ConflictSide {
  windowId: string;
  operator: string;
  /** 该侧是否仍占用名额（false 表示断网期间已释放） */
  claimed: boolean;
  valid: boolean;
  contentRev: number;
  at: string;
}

/** 断网交接合并后、同一渠道两边都改过的待决项 */
export interface ConflictItem {
  id: string;
  key: string;
  noticeId: string;
  version: string;
  channelId: string;
  locale: string;
  local: ConflictSide;
  remote: ConflictSide;
  status: 'pending';
  createdAt: string;
}

export interface ReleaseRecord {
  key: string;
  windowId: string;
  operator: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  level: 'info' | 'success' | 'warning' | 'danger';
  text: string;
}

/** 渠道台账：所有抢占、失效、确认、交接合并都围绕修订号推进 */
export interface Ledger {
  revision: number;
  /** 上次与对端同步时的修订号（断网分叉点） */
  syncedRevision: number;
  /** 分叉后本地改动过的名额键，用于断网合并判定双方同改 */
  dirtyKeys: string[];
  releases: ReleaseRecord[];
  channels: ChannelDef[];
  windows: DutyWindow[];
  notices: Record<string, NoticeStore>;
  claims: SlotClaim[];
  pendingDrafts: PendingDraft[];
  conflicts: ConflictItem[];
  log: AuditEntry[];
}

export interface AcquireRequest {
  windowId: string;
  noticeId: string;
  version: string;
  channelId: string;
  locale: string;
  /** 客户端持有的台账修订号；与现状不一致即视为过期凭据 */
  baseRevision?: number;
  /** 客户端持有的内容凭据；与当前 contentRev 不一致即拒绝 */
  contentRev?: number;
  at?: string;
}

export interface ContentChange {
  locale: string;
  title?: string;
  body?: string;
}

export interface ContentUpdateRequest {
  noticeId: string;
  version: string;
  scope?: string;
  changes: ContentChange[];
  at?: string;
}

export interface ContentUpdateSummary {
  contentRev: number;
  scopeChanged: boolean;
  invalidatedKeys: string[];
  /** 未触达语言：名额与确认原样保留 */
  retainedLocales: string[];
}

/** 断网交接包：按通知+版本携带内容与名额改动 */
export interface HandoffPackage {
  kind: 'flood-handoff-v1';
  fromWindowId: string;
  fromOperator: string;
  exportedAt: string;
  forkRevision: number;
  revision: number;
  notices: Record<string, NoticeStore>;
  claims: SlotClaim[];
  pendingDrafts: PendingDraft[];
  dirtyKeys: string[];
  releases: ReleaseRecord[];
  published: Array<{ noticeId: string; version: string; at: string }>;
}

export type Result<T> =
  | { ok: true; value: T; ledger: Ledger; message: string }
  | { ok: false; reason: DenyReason; ledger: Ledger; message: string; pending?: PendingDraft };

export interface MergeSummary {
  adoptedKeys: string[];
  conflictKeys: string[];
  mergedDrafts: number;
  mergedVersions: string[];
}

export interface PublishBlocker {
  code:
    | 'window-not-found'
    | 'publish-forbidden'
    | 'notice-not-found'
    | 'already-published'
    | 'conflict-open'
    | 'locale-content-missing'
    | 'locale-claim-missing'
    | 'claim-invalid'
    | 'confirm-pending';
  message: string;
}

/** 每个名额需要完成的角色确认 */
export const CONFIRM_ROLES = ['值班长复核', '发布人确认'] as const;
