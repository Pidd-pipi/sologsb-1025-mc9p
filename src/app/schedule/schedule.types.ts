/** 汛期渠道排期与交接发布：领域类型 */

export interface ScheduleLocale {
  id: string;
  name: string;
  /** 发布凭据 = 版本 + 标题 + 正文 + 影响范围的哈希，内容变动立即换发 */
  credential: string;
  version: string;
  title: string;
  body: string;
  scope: string;
}

export interface ScheduleNotice {
  id: string;
  /** 通知整体版本，随正文/标题/影响范围编辑递增 */
  version: string;
  scope: string;
  requiredLocaleIds: string[];
  locales: Record<string, ScheduleLocale>;
  updatedAt: string;
}

export interface ChannelDef {
  id: string;
  name: string;
  /** 每个语言在该渠道的有限名额（容量） */
  capacity: number;
  /** 被授权可提交该渠道的值班窗口 id */
  authorizedWindows: string[];
}

export interface SlotState {
  channelId: string;
  localeId: string;
  /** 当前占用窗口；null 表示名额空闲 */
  holderWindowId: string | null;
  holderOperator: string;
  /** 占用时凭据；与当前语言凭据不一致即失效，必须重算 */
  credential: string;
  version: string;
  /** 各值班窗口最后一次成功写入的修订号（乐观并发向量） */
  revisions: Record<string, number>;
  updatedAt: string;
}

export type RoleKey = 'duty-lead' | 'channel-auditor';

export interface RoleConfirmation {
  channelId: string;
  localeId: string;
  role: RoleKey;
  roleName: string;
  owner: string;
  /** 确认所针对的版本凭据，凭据变了即失效 */
  credential: string;
  confirmedAt: string;
}

/** 抢占失败/被接管方留下的待处理稿 */
export interface PendingDraft {
  id: string;
  channelId: string;
  localeId: string;
  windowId: string;
  operator: string;
  credential: string;
  version: string;
  reason: 'race-lost' | 'displaced' | 'conflict-remote';
  /** 抢占成功 / 接管当前名额的人 */
  takeoverWindowId: string;
  takeoverOperator: string;
  createdAt: string;
  handled: boolean;
  /** 正文/标题/影响范围已变动，凭据作废 */
  stale: boolean;
}

/** 断网期间窗口本地的一次写入 */
export interface OutboxChange {
  id: string;
  windowId: string;
  channelId: string;
  localeId: string;
  type: 'grab' | 'release';
  /** 断网时所依据的本地修订向量 */
  baseRevisions: Record<string, number>;
  credential: string;
  version: string;
  createdAt: string;
}

export type ConflictResolution = 'pending' | 'keep-local' | 'keep-remote';

export interface SlotConflict {
  id: string;
  channelId: string;
  localeId: string;
  /** 交接包按 通知+版本 归并后，同一渠道两边都改 */
  noticeId: string;
  version: string;
  localWindowId: string;
  remoteWindowId: string;
  localChange: OutboxChange | null;
  remoteChange: OutboxChange | null;
  resolution: ConflictResolution;
  createdAt: string;
}

export interface PublishRecord {
  id: string;
  noticeId: string;
  channelId: string;
  localeId: string;
  windowId: string;
  operator: string;
  version: string;
  credential: string;
  publishedAt: string;
}

export interface EventLog {
  id: string;
  level: 'info' | 'success' | 'warning' | 'danger';
  message: string;
  createdAt: string;
}

export interface ScheduleState {
  notice: ScheduleNotice;
  channels: ChannelDef[];
  windows: DutyWindow[];
  slots: Record<string, SlotState>;
  confirmations: RoleConfirmation[];
  pendingDrafts: PendingDraft[];
  conflicts: SlotConflict[];
  outbox: OutboxChange[];
  publishes: PublishRecord[];
  logs: EventLog[];
}

export interface DutyWindow {
  id: string;
  name: string;
  operator: string;
  online: boolean;
}

export interface GrabResult {
  ok: boolean;
  reason?: 'unauthorized' | 'offline';
  slotKey?: string;
  /** 抢占前的旧占用者（盖掉旧排期时使用） */
  displacedWindowId?: string | null;
  conflictId?: string;
}

export interface RaceResult {
  winnerWindowId: string | null;
  rejected: Array<{ windowId: string; reason: string }>;
  pendingDraftIds: string[];
  slotKey: string;
}

/** 断网交接包：按通知和版本携带 */
export interface HandoverPackage {
  kind: 'flood-handoff';
  exportedAt: string;
  exportedByWindowId: string;
  notice: ScheduleNotice;
  changes: OutboxChange[];
}
