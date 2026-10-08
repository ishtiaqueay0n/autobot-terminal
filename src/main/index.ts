import { app, BrowserWindow, clipboard, ipcMain, Menu, safeStorage, shell } from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';
import { Assistant } from './assistant';
import { debugLog, startLagMonitor, timed, timedAsync } from './debug';
import { HistoryService } from './history/service';
import { envForProfile } from './kb/exec';
import { stopSpawner } from './kb/spawner';
import { KeyStore, safeStorageEncryptor } from './llm/keystore';
import { detectLocalProfiles, detectWslProfiles, type ResolvedProfile } from './profiles';
import { PtySession } from './session';
import { SettingsStore } from './settings';
import { writeRemoteCommandFile } from './ssh-bootstrap';
import { WslShells } from './wsl-shells';
import { historyKey } from '../shared/shell';
import type { CompletionReason, SessionInfo, Settings, ShellProfile } from '../shared/types';

debugLog('main module loaded');
app.setName('Autobot Terminal');

/**
 * Linux: Chromium only looks for a keyring on desktops it knows (GNOME, KDE, Xfce ...). On others (i3, sway,
 * a bare session) it falls back to a fixed built-in password, which would make a saved API key readable by
 * anyone, and the key store then refuses to save it. Ask for libsecret there: it works with any Secret Service
 * (GNOME Keyring, KeePassXC, KWallet). Without a running keyring, safeStorage reports "unavailable" as before.
 */
const KNOWN_DESKTOP = /gnome|unity|cinnamon|deepin|kde|plasma|pantheon|xfce|ukui|lxqt|lxde|mate|budgie|cosmic/i;
if (
  process.platform === 'linux' &&
  !app.commandLine.hasSwitch('password-store') &&
  !KNOWN_DESKTOP.test(`${process.env.XDG_CURRENT_DESKTOP ?? ''} ${process.env.DESKTOP_SESSION ?? ''}`)
) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}
// Same folder name on every OS: %APPDATA%\autobot-terminal, ~/.config/autobot-terminal.
// AUTOBOT_USER_DATA points it elsewhere (tests, a portable setup).
app.setPath('userData', process.env.AUTOBOT_USER_DATA || join(app.getPath('appData'), 'autobot-terminal'));

interface OwnedSession {
  session: PtySession;
  ownerId: number;
}

const sessions = new Map<number, OwnedSession>();
let nextSessionId = 1;
let settings: SettingsStore;
let history: HistoryService;
let assistant: Assistant;
let sshCommandFile = '';
let localProfiles: ResolvedProfile[] = [];
let wslProfiles: Promise<ResolvedProfile[]> = Promise.resolve([]);

/** Finds a profile without waiting on the (slow) WSL listing unless a WSL profile is needed. */
async function resolveProfile(wanted: string | null): Promise<ResolvedProfile | undefined> {
  if (wanted && !wanted.startsWith('wsl:')) {
    const local = localProfiles.find((p) => p.id === wanted);
    if (local) return local;
  }
  if (!wanted && localProfiles.length > 0) return localProfiles[0];
  const wsl = await wslProfiles;
  return wsl.find((p) => p.id === wanted) ?? localProfiles[0] ?? wsl[0];
}

/** Bundled resources live next to the asar archive when packaged, in ./resources during development. */
function resourcePath(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(app.getAppPath(), 'resources', ...parts);
}

function shellDir(): string {
  return resourcePath('shell');
}

function publicProfile({ id, name, kind, pathStyle, wslDistro }: ResolvedProfile): ShellProfile {
  return { id, name, kind, pathStyle, wslDistro };
}

function windowsBuild(): number {
  return Number.parseInt(release().split('.')[2] ?? '0', 10) || 0;
}

function openExternalSafe(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url);
  } catch {
    // Not a URL.
  }
}

function ownedSession(senderId: number, sessionId: unknown): PtySession | undefined {
  if (typeof sessionId !== 'number') return undefined;
  const entry = sessions.get(sessionId);
  return entry && entry.ownerId === senderId ? entry.session : undefined;
}

function registerIpc(): void {
  ipcMain.handle('profiles:list', async () => [...localProfiles, ...(await wslProfiles)].map(publicProfile));

  ipcMain.handle('session:create', async (event, profileId: unknown, cols: unknown, rows: unknown): Promise<SessionInfo> => {
    const wanted = typeof profileId === 'string' ? profileId : settings.get().defaultProfile;
    const profile = await resolveProfile(wanted);
    if (!profile) throw new Error('No supported shell was found on this system.');
    debugLog(`session:create ${profile.id}`);

    const id = nextSessionId++;
    const owner = event.sender;
    history.startSession(id, profile.kind, envForProfile(profile));
    assistant.startSession(id, profile);
    const session = new PtySession({
      id,
      profile,
      shellDir: shellDir(),
      ssh: { mode: settings.get().sshIntegration, commandFile: sshCommandFile },
      cols: Number(cols),
      rows: Number(rows),
      onEvents: (events) => {
        timed('assistant.onEvents', () => assistant.onEvents(id, events));
        for (const ev of events) {
          // "always" or "never" answered in the terminal at the ssh wrapper's question.
          if (ev.type === 'property' && ev.key === 'SshChoice' && (ev.value === 'on' || ev.value === 'off')) {
            settings.update({ sshIntegration: ev.value });
          }
        }
        // What a remote shell reports (command lists) is large and only the assistant reads it (the home folder is for the prompt bar too).
        const forWindow = events.filter((ev) => !(ev.type === 'property' && ev.key.startsWith('Remote') && ev.key !== 'RemoteHome'));
        if (!owner.isDestroyed() && forWindow.length > 0) owner.send('session:events', id, forWindow);
      },
      onExit: (exitCode) => {
        sessions.delete(id);
        history.endSession(id);
        assistant.endSession(id);
        if (!owner.isDestroyed()) owner.send('session:exit', id, exitCode);
      },
      onCommandFinished: (result) => {
        timed('history.recordFinished', () => history.recordFinished(id, profile.kind, result));
        // Through the session's queue, so the fix reaches the window after the prompt it belongs to.
        timed('assistant.commandFinished', () =>
          assistant.commandFinished(id, result, (fix) => session.emit([{ type: 'fix', command: result.command, fix }])),
        );
      },
    });
    assistant.bindSession(id, (op, arg) => session.askRemote(op, arg));
    sessions.set(id, { session, ownerId: owner.id });
    return {
      sessionId: id,
      profile: publicProfile(profile),
      windowsPty: process.platform === 'win32' ? { backend: 'conpty', buildNumber: windowsBuild() } : undefined,
    };
  });

  ipcMain.on('session:write', (event, sessionId: unknown, data: unknown) => {
    if (typeof data === 'string') ownedSession(event.sender.id, sessionId)?.write(data);
  });
  ipcMain.on('session:submit', (event, sessionId: unknown, text: unknown, record: unknown) => {
    if (typeof text === 'string') ownedSession(event.sender.id, sessionId)?.submit(text, record === true);
  });
  ipcMain.handle('history:suggest', (event, sessionId: unknown, text: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    if (!session || typeof text !== 'string') return null;
    return timed('history.suggest', () =>
      history.suggest(session.id, historyKey(session.profile.kind, session.remoteContext), text, session.currentCwd),
    );
  });
  ipcMain.handle('history:recent', (event, sessionId: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    return session ? history.recent(historyKey(session.profile.kind, session.remoteContext)) : [];
  });
  ipcMain.handle('complete', async (event, sessionId: unknown, text: unknown, cursor: unknown, reason: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    if (!session || typeof text !== 'string' || typeof cursor !== 'number') return null;
    const why: CompletionReason = reason === 'tab' || reason === 'panel' ? reason : 'auto';
    try {
      return await timedAsync(`complete (${why})`, () =>
        assistant.complete(session, text, Math.max(0, Math.min(cursor, text.length)), why),
      );
    } catch (err) {
      console.error('[complete]', err);
      return null;
    }
  });
  ipcMain.handle('check', async (event, sessionId: unknown, text: unknown, cursor: unknown, submit: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    if (!session || typeof text !== 'string' || typeof cursor !== 'number') return [];
    try {
      return await timedAsync('check', () =>
        assistant.check(session, text, Math.max(0, Math.min(cursor, text.length)), submit === true),
      );
    } catch (err) {
      console.error('[check]', err);
      return [];
    }
  });
  ipcMain.on('session:resize', (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    ownedSession(event.sender.id, sessionId)?.resize(Number(cols), Number(rows));
  });
  ipcMain.on('session:kill', (event, sessionId: unknown) => {
    ownedSession(event.sender.id, sessionId)?.kill();
    if (typeof sessionId === 'number') sessions.delete(sessionId);
  });

  ipcMain.handle('ai:fix', async (event, sessionId: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    if (!session) return { ok: false, message: 'This tab is closed.' };
    return assistant.aiFix(session.id);
  });
  ipcMain.handle('ai:explain', async (event, sessionId: unknown, text: unknown, cursor: unknown) => {
    const session = ownedSession(event.sender.id, sessionId);
    if (!session || typeof text !== 'string' || typeof cursor !== 'number') return { ok: false, message: 'This tab is closed.' };
    return assistant.aiExplain(session, text, Math.max(0, Math.min(cursor, text.length)));
  });
  ipcMain.handle('ai:status', () => assistant.ai.status());
  // The key goes one way: from the settings dialog into the OS key store. It is never sent back.
  ipcMain.handle('ai:setKey', (_event, key: unknown) => {
    try {
      if (typeof key !== 'string') throw new Error('Invalid key.');
      return { ok: true, status: assistant.ai.setKey(key) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), status: assistant.ai.status() };
    }
  });
  ipcMain.handle('ai:test', () => assistant.ai.test());

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return settings.get();
    return settings.update(patch as Partial<Settings>);
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.on('shell:openExternal', (_event, url: unknown) => {
    if (typeof url === 'string') openExternalSafe(url);
  });
}

function createWindow(): void {
  const light = settings.get().theme === 'light';
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 300,
    title: 'Autobot Terminal',
    backgroundColor: light ? '#f7f7f5' : '#15171c',
    // Windows takes the icon from the executable; Linux window managers need it here.
    icon: process.platform === 'linux' ? resourcePath('icon.png') : undefined,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const ownerId = win.webContents.id;

  win.once('ready-to-show', () => {
    debugLog('window ready-to-show');
    win.show();
  });
  win.webContents.once('did-finish-load', () => debugLog('renderer did-finish-load'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('before-input-event', (event, input) => {
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (input.type === 'keyDown' && devtools) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  win.on('closed', () => {
    for (const [id, entry] of sessions) {
      if (entry.ownerId === ownerId) {
        entry.session.kill();
        sessions.delete(id);
      }
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  debugLog('app ready');
  if (process.platform === 'linux' && process.env.AUTOBOT_DEBUG === '1') {
    debugLog(`key store backend: ${safeStorage.getSelectedStorageBackend()}`);
  }
  startLagMonitor();
  // The default menu's accelerators (Ctrl+W, Ctrl+R, ...) collide with shell keys.
  Menu.setApplicationMenu(null);
  settings = new SettingsStore(app.getPath('userData'));
  settings.watch((next) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('settings:changed', next);
  });
  sshCommandFile = join(app.getPath('userData'), 'ssh-remote-command.txt');
  history = HistoryService.open(join(app.getPath('userData'), 'history.db'), () => settings.get());
  localProfiles = detectLocalProfiles();
  const wslShells = new WslShells(join(app.getPath('userData'), 'wsl-shells.json'));
  wslProfiles = detectWslProfiles(process.platform, wslShells.zshDistros());
  const powershell = localProfiles.find((p) => p.kind === 'powershell')?.executable ?? null;
  const keys = new KeyStore(join(app.getPath('userData'), 'claude-key.bin'), safeStorageEncryptor(safeStorage));
  assistant = new Assistant(resourcePath('kb'), app.getPath('userData'), () => settings.get(), history, powershell, keys);
  assistant.onWslZsh = (distro) => wslShells.noteZsh(distro);
  // After the first window is up: importing and learning are not needed for the first keystroke.
  setTimeout(() => {
    void history.importLocal().then(() => setTimeout(() => assistant.prefetchLocal(), 8000));
  }, 1500);
  // The command the ssh wrapper in the shell hooks sends along with a login (see ssh-bootstrap.ts).
  try {
    writeRemoteCommandFile(shellDir(), sshCommandFile);
  } catch (err) {
    console.error('[ssh] could not write the remote command; ssh sessions will not get suggestions:', err);
  }
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  for (const { session } of sessions.values()) session.kill();
  sessions.clear();
  settings?.dispose();
  history?.close();
  assistant?.close();
  stopSpawner();
});
