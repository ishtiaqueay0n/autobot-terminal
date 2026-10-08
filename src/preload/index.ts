import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AutobotApi, SessionEvent, Settings } from '../shared/types';

function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as T));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: AutobotApi = {
  platform: process.platform,
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createSession: (profileId, cols, rows) => ipcRenderer.invoke('session:create', profileId, cols, rows),
  write: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
  submit: (sessionId, text, record) => ipcRenderer.send('session:submit', sessionId, text, record),
  suggest: (sessionId, text) => ipcRenderer.invoke('history:suggest', sessionId, text),
  historyRecent: (sessionId) => ipcRenderer.invoke('history:recent', sessionId),
  complete: (sessionId, text, cursor, reason) => ipcRenderer.invoke('complete', sessionId, text, cursor, reason),
  check: (sessionId, text, cursor, submit) => ipcRenderer.invoke('check', sessionId, text, cursor, submit),
  resize: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
  kill: (sessionId) => ipcRenderer.send('session:kill', sessionId),
  onSessionEvents: (listener) => subscribe<[number, SessionEvent[]]>('session:events', listener),
  onSessionExit: (listener) => subscribe<[number, number]>('session:exit', listener),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onSettingsChanged: (listener) => subscribe<[Settings]>('settings:changed', listener),
  aiFix: (sessionId) => ipcRenderer.invoke('ai:fix', sessionId),
  aiExplain: (sessionId, text, cursor) => ipcRenderer.invoke('ai:explain', sessionId, text, cursor),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSetKey: (key) => ipcRenderer.invoke('ai:setKey', key),
  aiTest: () => ipcRenderer.invoke('ai:test'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
};

contextBridge.exposeInMainWorld('autobot', api);
