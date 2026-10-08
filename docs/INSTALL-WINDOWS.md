# Installing Autobot Terminal on Windows

## The file you need

One file: **`Autobot-Terminal-Setup-<version>.exe`** (about 120 MB), from the
[Releases page](https://github.com/ishtiaqueay0n/autobot-terminal/releases/latest). Compare its SHA-256
(`Get-FileHash <file>` in PowerShell) with `SHA256SUMS.txt` there. It contains everything the app needs: you don't
need to install Node.js, the Visual C++ runtime, .NET, PowerShell 7 or anything else first.

## Requirements

- Windows 10 version 1903 (build 18362) or newer, or Windows 11. 64-bit.
  Check with `winver`. The installer stops with a message on older builds.
- About 400 MB of disk space.
- No administrator rights. The app installs for your user account only.

## Install

1. Double-click `Autobot-Terminal-Setup-<version>.exe`.
2. Wait 20–30 seconds. There are no questions to answer.
3. Autobot Terminal opens by itself when it's done.

The installer:

- installs the app to `%LOCALAPPDATA%\Programs\autobot-terminal`,
- adds an **Autobot Terminal** shortcut to the desktop and the Start menu,
- adds an entry under **Settings → Apps** so you can uninstall it.

The first start after installing can take a few seconds longer while Windows Defender scans the new files. After
that it opens in about 2 seconds.

### "Windows protected your PC"

The installer isn't code-signed. Windows shows this blue SmartScreen warning when the file came from the internet,
email or a chat app; a file you built yourself on the same PC doesn't trigger it. To continue:

1. Click **More info**.
2. Click **Run anyway**.

Or, before running it: right-click the file → **Properties** → tick **Unblock** → **OK**.

## Which shells you get

Autobot opens your shells; it doesn't install any.

| Shell | When it appears |
|-------|-----------------|
| Windows PowerShell 5.1 | Always. It's part of Windows. |
| PowerShell 7 | When it's installed. It then becomes the default for new tabs. Install with `winget install Microsoft.PowerShell`. |
| Command Prompt (cmd.exe) | Always. It's part of Windows; choose it in the **+ ▾** menu. |
| WSL distros (e.g. Ubuntu) | When WSL is installed. Each distro shows up in the **+ ▾** menu. Install with `wsl --install`. |
| zsh in a WSL distro | After a bash tab in that distro has run once and found zsh installed (`sudo apt install zsh` in the distro); from the next start the menu also lists "Ubuntu (WSL, zsh)". |

To pick the default shell yourself, set `defaultProfile` in the settings file: `pwsh`, `powershell`, `cmd`,
`wsl:Ubuntu` or `wsl:Ubuntu:zsh`.

## Settings

`%APPDATA%\autobot-terminal\settings.json` is created on first start. Changes apply as soon as you save the file.
See the [README](../README.md#settings) for the options.

Your command history is in `history.db` in the same folder. On first start Autobot imports your existing PowerShell
history (read-only) so suggestions work from day one. See [History and privacy](../README.md#history-and-privacy).

## Turn on AI help (optional)

Everything works without it. To add AI fixes (Ctrl+.) and tool descriptions:

1. Create an API key in the [Claude Console](https://console.anthropic.com/settings/keys). Usage is billed to
   that account; the default model, Claude Haiku 4.5, is the lowest-cost one.
2. In Autobot, click **AI** at the right end of the tab bar.
3. Paste the key and click **Save**. Autobot tests it right away; the status line turns green and so does the dot
   on the AI button.

The key is encrypted by Windows for your user account (`claude-key.bin` next to `settings.json`); it is never
stored as plain text and never shown again. To remove it, open the dialog and click **Remove it**. Prefer a local
model? Choose **Ollama (local)** and enter your Ollama server and model; nothing leaves your machine then.

## Update

Run the newer `Autobot-Terminal-Setup-<version>.exe`. It replaces the old version in place and keeps your settings.
If Autobot is still open, the installer offers to close it (click **OK**).

## Uninstall

**Settings → Apps → Installed apps → Autobot Terminal → Uninstall.**

This removes the app and its shortcuts. Your settings and command history in `%APPDATA%\autobot-terminal` are
kept, in case you reinstall. Delete that folder by hand if you want them gone too.

## Portable version (no install)

`Autobot-Terminal-<version>-portable.exe` runs without installing, for example from a USB stick. It unpacks itself
to a temporary folder on every start, so each start takes 10–15 seconds. For daily use, install with the Setup file.

## Troubleshooting

**The installer says Windows is too old.** Update Windows (Settings → Windows Update) to version 1903 or newer.
Autobot needs a part of Windows that older builds don't have.

**The app starts slowly or a tab stays on "starting".** Run it with timing logs and look at where the time goes:

```bat
set AUTOBOT_DEBUG=1
"%LOCALAPPDATA%\Programs\autobot-terminal\autobot.exe" 2> "%TEMP%\autobot.log"
notepad "%TEMP%\autobot.log"
```

On a normal start, `session 1: first prompt` appears within about 2 seconds.

**A tab shows "Could not start the shell".** The shell it tried to open is missing. Pick another one from
**+ ▾**, or fix `defaultProfile` in the settings file.

**PowerShell profile errors appear when a tab opens.** Autobot loads your normal PowerShell profile
(`$PROFILE`), so errors in it show up here the same way they would in any other terminal.
