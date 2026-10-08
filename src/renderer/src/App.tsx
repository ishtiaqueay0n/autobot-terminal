import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatus, Settings, ShellProfile } from '@shared/types';
import { AiSettings } from './components/AiSettings';
import { Preferences } from './components/Preferences';
import { TabBar, type TabEntry } from './components/TabBar';
import { TerminalPane } from './components/TerminalPane';
import { TerminalController } from './terminal/controller';
import { applyDocumentSettings } from './theme';

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // Refs mirror state for keyboard handlers and callbacks that outlive a render.
  const settingsRef = useRef<Settings | null>(null);
  const tabsRef = useRef<TabEntry[]>([]);
  const activeKeyRef = useRef<number | null>(null);
  const nextKey = useRef(1);
  const openedFirst = useRef(false);
  const aiReadyRef = useRef(false);
  tabsRef.current = tabs;
  activeKeyRef.current = activeKey;

  const closeTab = useCallback((key: number) => {
    const current = tabsRef.current;
    const index = current.findIndex((t) => t.key === key);
    if (index === -1) return;
    current[index].controller.dispose();
    const next = current.filter((t) => t.key !== key);
    if (next.length === 0) {
      window.close();
      return;
    }
    setTabs(next);
    if (activeKeyRef.current === key) setActiveKey(next[Math.min(index, next.length - 1)].key);
  }, []);

  const openTab = useCallback(
    (profileId: string | null) => {
      if (!settingsRef.current) return;
      const key = nextKey.current++;
      const controller = new TerminalController(profileId, settingsRef.current);
      controller.setAiReady(aiReadyRef.current);
      // A clean `exit` closes the tab; a crash keeps it open so the message stays readable.
      controller.onExit = (code) => {
        if (code === 0) closeTab(key);
      };
      setTabs((prev) => [...prev, { key, controller }]);
      setActiveKey(key);
    },
    [closeTab],
  );

  useEffect(() => {
    let alive = true;
    void window.autobot.getSettings().then((s) => {
      if (!alive) return;
      settingsRef.current = s;
      applyDocumentSettings(s);
      setSettings(s);
    });
    void window.autobot.listProfiles().then((p) => alive && setProfiles(p));
    void window.autobot.aiStatus().then((a) => alive && setAiStatus(a));
    const off = window.autobot.onSettingsChanged((s) => {
      settingsRef.current = s;
      applyDocumentSettings(s);
      setSettings(s);
      for (const tab of tabsRef.current) tab.controller.applySettings(s);
      void window.autobot.aiStatus().then((a) => alive && setAiStatus(a));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    aiReadyRef.current = Boolean(aiStatus?.ready);
    for (const tab of tabsRef.current) tab.controller.setAiReady(aiReadyRef.current);
  }, [aiStatus, tabs]);

  const closeAi = useCallback(() => {
    setAiOpen(false);
    tabsRef.current.find((t) => t.key === activeKeyRef.current)?.controller.focus();
  }, []);

  const closePrefs = useCallback(() => {
    setPrefsOpen(false);
    tabsRef.current.find((t) => t.key === activeKeyRef.current)?.controller.focus();
  }, []);

  useEffect(() => {
    if (settings && !openedFirst.current) {
      openedFirst.current = true;
      openTab(null);
    }
  }, [settings, openTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      const all = tabsRef.current;
      const active = all.find((t) => t.key === activeKeyRef.current);
      let handled = true;

      if (e.shiftKey && key === 't') openTab(null);
      else if (e.shiftKey && key === 'w') {
        if (active) closeTab(active.key);
      } else if (key === 'tab' && all.length > 0) {
        const index = all.findIndex((t) => t.key === activeKeyRef.current);
        const step = e.shiftKey ? -1 : 1;
        setActiveKey(all[(index + step + all.length) % all.length].key);
      } else if (e.shiftKey && key === 'c') active?.controller.copy();
      else if (e.shiftKey && key === 'v') void active?.controller.paste();
      else handled = false;

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Capture phase: runs before xterm and the editor see the key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openTab, closeTab]);

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeKey={activeKey}
        profiles={profiles}
        onSelect={setActiveKey}
        onClose={closeTab}
        onOpen={openTab}
        ai={aiStatus}
        onOpenSettings={() => setPrefsOpen(true)}
        onOpenAi={() => {
          setAiOpen(true);
          void window.autobot.aiStatus().then(setAiStatus);
        }}
      />
      <div className="panes">
        {tabs.map((tab) => (
          <TerminalPane key={tab.key} controller={tab.controller} active={tab.key === activeKey} />
        ))}
      </div>
      {prefsOpen && settings && <Preferences settings={settings} onClose={closePrefs} />}
      {aiOpen && settings && <AiSettings status={aiStatus} settings={settings} onStatus={setAiStatus} onClose={closeAi} />}
    </div>
  );
}
