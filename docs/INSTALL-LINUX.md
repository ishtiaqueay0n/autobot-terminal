# Installing Autobot Terminal on Linux

Autobot runs on **Ubuntu 22.04 and 24.04** and **RHEL 8 and 9** (also Rocky Linux and AlmaLinux), x86_64, with a
desktop session (X11 or Wayland). One build covers all of them.

## Which file do you need?

Download it from the [Releases page](https://github.com/ishtiaqueay0n/autobot-terminal/releases/latest) and compare
its SHA-256 (`sha256sum <file>`) with `SHA256SUMS.txt` there.

| System | File | Install |
|--------|------|---------|
| RHEL, Rocky, AlmaLinux | `autobot-terminal-0.1.0.x86_64.rpm` | `sudo dnf install ./autobot-terminal-0.1.0.x86_64.rpm` |
| Ubuntu | `autobot-terminal_0.1.0_amd64.deb` | `sudo apt install ./autobot-terminal_0.1.0_amd64.deb` |
| Other distributions (untested) | `Autobot-Terminal-0.1.0-x86_64.AppImage` | `chmod +x` it and run it (see below) |

The package manager installs the libraries Autobot needs (GTK 3, NSS, libsecret and a few more). Start it from
the application menu (**Autobot Terminal**) or run `autobot`.

### The AppImage

An AppImage mounts itself with FUSE 2, which a minimal Ubuntu does not have (the error is
`dlopen(): error loading libfuse.so.2`):

```bash
sudo apt install libfuse2 fuse         # Ubuntu 22.04
sudo apt install libfuse2t64 fuse3     # Ubuntu 24.04
sudo dnf install fuse fuse-libs        # RHEL 8 / 9
```

Without FUSE, run `./Autobot-Terminal-0.1.0-x86_64.AppImage --appimage-extract-and-run`; it unpacks to a temporary
folder and starts the same way. The AppImage does not install system libraries: GTK 3, NSS, libsecret, libgbm and
libasound must already be on the system, which they are on any normal desktop. The `.rpm` and `.deb` declare them.

## First start

Autobot opens your login shell, `bash` or `zsh` (both are on the **+ ▾** menu; `defaultProfile` in the settings file
picks one). Your own `~/.bashrc` or `~/.zshrc` (or `$ZDOTDIR`) loads first, so prompts and plugins keep working;
login-only files such as `.profile` and `.zprofile` are not read. Its data is in `~/.config/autobot-terminal/`: `settings.json`,
`history.db` (your command history, imported once from `~/.bash_history` and `~/.zsh_history`), `knowledge.db` (what it learned about your tools) and,
if you set one up, `claude-key.bin`. See the [README](../README.md#settings) for the settings.

## Turn on AI help (optional)

Everything works without it. To add AI fixes (Ctrl+.) and tool descriptions, click **AI** at the right end of the
tab bar and paste a Claude API key from the [Claude Console](https://console.anthropic.com/settings/keys).

On Linux the key is only saved in your **keyring** (GNOME Keyring, KWallet or KeePassXC through the Secret Service),
never as plain text. Desktop sessions have one running already. Without one (a server, WSL, a minimal window manager)
the dialog says so, and you can set the key for a single start from a terminal instead:

```bash
ANTHROPIC_API_KEY=sk-ant-... autobot
```

Menu launches do not read `~/.bashrc`. On desktops that import systemd user environments (recent GNOME and KDE), a
line `ANTHROPIC_API_KEY=sk-ant-...` in `~/.config/environment.d/autobot.conf` (keep it private: `chmod 600`) followed
by logging in again makes it available to menu launches; elsewhere, start Autobot from a terminal. Prefer a local
model? Choose **Ollama (local)** in the dialog; nothing leaves your machine then.

## Update and uninstall

Install the newer package the same way (`dnf install` / `apt install` of the new file upgrades in place); your
settings and history stay. To remove:

```bash
sudo dnf remove autobot-terminal       # RHEL family
sudo apt remove autobot-terminal       # Ubuntu
```

Your data in `~/.config/autobot-terminal/` is kept; delete the folder to remove it too.

## Troubleshooting

| Problem | What to do |
|---------|------------|
| The window is blank or flickers | Start with `autobot --disable-gpu`. |
| "The SUID sandbox helper binary was found, but is not configured correctly" | The package sets this up. For a manually unpacked copy: `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`, or start with `--no-sandbox` (less safe). |
| The AppImage does not start (`dlopen(): error loading libfuse.so.2`) | Install FUSE 2 or use `--appimage-extract-and-run` (see above). |
| Ubuntu 24.04: the AppImage stops with a sandbox error | Ubuntu 24.04 restricts unprivileged user namespaces, which an AppImage cannot get around. Install the `.deb` instead (it adds an AppArmor profile), or start the AppImage with `--no-sandbox` (less safe). This case has not been tested. |
| "No keyring was found" in the AI dialog | Start GNOME Keyring, KWallet or KeePassXC, or use `ANTHROPIC_API_KEY` as described above. |
| Nothing suggests commands from history | The first start imports `~/.bash_history`; commands typed with a leading space are never saved. |
