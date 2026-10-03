// 汛期渠道交接发布 · 初始台账与演示场景
import { acquireSlot, confirmRole } from './handoff.engine';
import { ChannelDef, DutyWindow, Ledger } from './handoff.model';

export const FLOOD_CHANNELS: ChannelDef[] = [
  { id: 'sms', name: '短信网关', capacity: 2 },
  { id: 'broadcast', name: '应急广播', capacity: 1 },
  { id: 'screen', name: '社区大屏', capacity: 2 },
  { id: 'wechat', name: '政务新媒体', capacity: 3 }
];

export const DUTY_WINDOWS: DutyWindow[] = [
  { id: 'win-day', name: '白班值班窗', operator: '林晓', role: '值班员', allowedChannelIds: ['sms', 'broadcast'], canPublish: false },
  { id: 'win-night', name: '夜班值班窗', operator: '周海', role: '值班员', allowedChannelIds: ['screen', 'wechat'], canPublish: false },
  { id: 'win-publisher', name: '市防办发布席', operator: '陈岚', role: '发布人', allowedChannelIds: ['sms', 'broadcast', 'screen', 'wechat'], canPublish: true }
];

export const NOTICE_ID = 'flood-20261003';

export function initialHandoffLedger(): Ledger {
  const at = '2026-10-03T08:00:00+08:00';
  let ledger: Ledger = {
    revision: 0,
    syncedRevision: 0,
    dirtyKeys: [],
    releases: [],
    channels: FLOOD_CHANNELS,
    windows: DUTY_WINDOWS,
    notices: {
      [NOTICE_ID]: {
        versions: {
          '2026.10.3-1': {
            noticeId: NOTICE_ID,
            version: '2026.10.3-1',
            scope: '沿江低洼地段',
            requiredLocales: ['zh-CN', 'en'],
            locales: {
              'zh-CN': {
                title: '汛期避险提醒（第一版）',
                body: '未来六小时沿江低洼地段可能出现积水。请居民减少外出，远离河道与地下通道。'
              },
              en: {
                title: 'Flood season safety advisory (v1)',
                body: 'Waterlogging is possible in low-lying riverside areas in the next six hours. Please stay indoors and keep away from rivers and underpasses.'
              }
            },
            contentRev: 1,
            published: false
          },
          '2026.10.3-2': {
            noticeId: NOTICE_ID,
            version: '2026.10.3-2',
            scope: '沿江低洼地段及老城排水分区',
            requiredLocales: ['zh-CN', 'en', 'ja'],
            locales: {
              'zh-CN': {
                title: '汛期转移提醒（第二版）',
                body: '受上游来水影响，沿江低洼地段及老城排水分区请于14时前转移至高处安置点。请立即停止水上作业，随身携带应急物品。'
              },
              en: {
                title: 'Flood evacuation advisory (v2)',
                body: 'Due to upstream inflow, residents in low-lying riverside areas and the old-town drainage zone must move to elevated shelters before 14:00. Stop all waterside work immediately and carry emergency supplies.'
              },
              ja: {
                title: '増水期の避難呼びかけ（第2版）',
                body: '上流からの流入により、川沿いの低地と旧市街の排水区域の住民は14時までに高所の避難所へ移動してください。水辺の作業を直ちに中止し、非常用品を携行してください。'
              }
            },
            contentRev: 3,
            published: false
          }
        }
      }
    },
    claims: [],
    pendingDrafts: [],
    conflicts: [],
    log: []
  };

  // 预置抢占：白班占了短信 zh-CN（旧版排期，稍后会被新版盖掉）
  let r = acquireSlot(ledger, { windowId: 'win-day', noticeId: NOTICE_ID, version: '2026.10.3-1', channelId: 'sms', locale: 'zh-CN', contentRev: 1 }, '2026-10-03T08:05:00+08:00');
  if (r.ok) ledger = r.ledger;
  // 新版抢占短信 zh-CN：盖掉旧排期
  r = acquireSlot(ledger, { windowId: 'win-day', noticeId: NOTICE_ID, version: '2026.10.3-2', channelId: 'sms', locale: 'zh-CN', contentRev: 3 }, '2026-10-03T09:20:00+08:00');
  if (r.ok) ledger = r.ledger;
  // 白班再占应急广播 zh-CN（广播仅 1 个名额，供夜班"同一位抢占"演示）
  r = acquireSlot(ledger, { windowId: 'win-day', noticeId: NOTICE_ID, version: '2026.10.3-2', channelId: 'broadcast', locale: 'zh-CN', contentRev: 3 }, '2026-10-03T09:22:00+08:00');
  if (r.ok) ledger = r.ledger;
  // 夜班占政务新媒体 en
  r = acquireSlot(ledger, { windowId: 'win-night', noticeId: NOTICE_ID, version: '2026.10.3-2', channelId: 'wechat', locale: 'en', contentRev: 3 }, '2026-10-03T09:30:00+08:00');
  if (r.ok) ledger = r.ledger;
  // 短信 zh-CN 已拿到双角色确认
  const smsKey = `${NOTICE_ID}|2026.10.3-2|sms|zh-CN`;
  ledger = confirmRole(ledger, smsKey, '值班长复核', '老班长', '2026-10-03T09:40:00+08:00');
  ledger = confirmRole(ledger, smsKey, '发布人确认', '陈岚', '2026-10-03T09:42:00+08:00');

  ledger.syncedRevision = ledger.revision;
  ledger.dirtyKeys = [];
  return ledger;
}
