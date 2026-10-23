/**
 * 消息协议常量。
 *
 * 三条链路：
 *   侧边栏 -> service worker     runtime.sendMessage
 *   service worker -> 侧边栏     runtime.sendMessage（广播）
 *   service worker <-> content   tabs.sendMessage / runtime.sendMessage
 */

/** 侧边栏 -> service worker */
export const UI = {
  GET_STATE: 'ui:getState',
  PICK: 'ui:pick',
  SYNC: 'ui:sync',
  DETAIL: 'ui:detail',
  SET_SCOPES: 'ui:setScopes',
  SET_UID: 'ui:setUid',
  CLEAR_HISTORY: 'ui:clearHistory',
  PROBE_LOGIN: 'ui:probeLogin',
}

/** service worker -> 侧边栏（广播） */
export const SW_EVENT = {
  STATE_CHANGED: 'sw:stateChanged',
  SYNC_PROGRESS: 'sw:syncProgress',
  SYNC_FINISHED: 'sw:syncFinished',
}

/** service worker -> content script */
export const CS = {
  PING: 'cs:ping',
  PROBE_LOGIN: 'cs:probeLogin',
  FETCH_ALL: 'cs:fetchAll',
  DETAIL: 'cs:detail',
}

/** content script -> service worker */
export const FROM_CS = {
  SYNC_RESULT: 'cs:syncResult',
  SYNC_PROGRESS: 'cs:syncProgress',
}

/** 错误码，侧边栏据此选择提示文案 */
export const ERROR = {
  NO_UID: 'NO_UID',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NO_DOUBAN_TAB: 'NO_DOUBAN_TAB',
  RATE_LIMITED: 'RATE_LIMITED',
  /** 距上次成功同步不足最短更新频率 */
  TOO_SOON: 'TOO_SOON',
  NETWORK: 'NETWORK',
  NO_SCOPE: 'NO_SCOPE',
  NO_CANDIDATES: 'NO_CANDIDATES',
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
  SYNCING: 'SYNCING',
}
