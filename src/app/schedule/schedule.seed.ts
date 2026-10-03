import { ScheduleState } from './schedule.types';
import { credentialOf, getSlot, uid } from './schedule.engine';

/** 汛期排期演示初始状态 */
export function seedState(): ScheduleState {
  const version = '2.1.0';
  const scope = '沿江四区低洼地段';
  const locales = {
    'zh-CN': {
      id: 'zh-CN', name: '简体中文', version, scope,
      title: '新安江流域汛期橙色避险通知',
      body: '预计未来六小时新安江上游出现强降雨。沿江低洼区域居民请立即转移至高地安置点。请勿在河道、涵洞与地下车库逗留。',
      credential: ''
    },
    en: {
      id: 'en', name: 'English', version, scope,
      title: "Orange flood-season evacuation notice for the Xin'an River basin",
      body: "Heavy rainfall is expected upstream of the Xin'an River within six hours. Residents in low-lying riverside areas must move to high-ground shelters immediately. Do not remain near riverbanks, culverts or underground parking.",
      credential: ''
    },
    ja: {
      id: 'ja', name: '日本語', version, scope,
      title: '新安川流域・汛期のオレンジ避難通知',
      body: '今後6時間以内に新安川上流域で大雨が見込まれます。低地の住民は直ちに高台の避難所へ移動してください。河川敷、カルバート、地下駐車場には近づかないでください。',
      credential: ''
    }
  };
  Object.values(locales).forEach((locale) => {
    locale.credential = credentialOf(locale.version, locale.title, locale.body, locale.scope);
  });

  const state: ScheduleState = {
    notice: {
      id: 'flood-xinan-2026',
      version,
      scope,
      requiredLocaleIds: ['zh-CN', 'en', 'ja'],
      locales,
      updatedAt: new Date().toISOString()
    },
    channels: [
      { id: 'sms', name: '短信网关', capacity: 1, authorizedWindows: ['window-a', 'window-b'] },
      { id: 'radio', name: '应急广播', capacity: 1, authorizedWindows: ['window-a'] },
      { id: 'screen', name: '社区大屏', capacity: 1, authorizedWindows: ['window-b'] },
      { id: 'web', name: '政务新媒体', capacity: 2, authorizedWindows: ['window-a', 'window-b'] }
    ],
    windows: [
      { id: 'window-a', name: '一号值班窗口', operator: '陆远征', online: true },
      { id: 'window-b', name: '二号值班窗口', operator: '高澜', online: true }
    ],
    slots: {},
    confirmations: [],
    pendingDrafts: [],
    conflicts: [],
    outbox: [],
    publishes: [],
    logs: []
  };

  // 旧排期：一号窗口上一班已占用短信·简体中文，便于演示“同时抢占盖掉旧排期”
  const zh = locales['zh-CN'];
  const seeded = getSlot(state, 'sms', 'zh-CN');
  seeded.holderWindowId = 'window-a';
  seeded.holderOperator = '陆远征';
  seeded.credential = zh.credential;
  seeded.version = zh.version;
  seeded.revisions['window-a'] = 1;
  seeded.updatedAt = new Date().toISOString();

  state.confirmations.push({
    channelId: 'sms', localeId: 'zh-CN', role: 'duty-lead', roleName: '值班长',
    owner: '陆远征', credential: zh.credential, confirmedAt: new Date().toISOString()
  });

  state.logs.push({
    id: uid('log'), level: 'info',
    message: '汛期排期初始化：短信网关·简体中文名额由一号窗口（陆远征）占用，值班长已确认。',
    createdAt: new Date().toISOString()
  });
  return state;
}
