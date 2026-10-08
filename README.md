# Autobot Terminal

A terminal for Windows and Linux that helps you type commands. It suggests what you are about to type, points out
mistakes before you press Enter, asks before anything destructive, and suggests a fix when a command fails. It also
works inside ssh sessions, and can use AI help if you want it. It never runs a command on its own.

## Download and install

Download the file for your system from the **[Releases page](https://github.com/ishtiaqueay0n/autobot-terminal/releases/latest)**
and check it against `SHA256SUMS.txt` there.

| System | File | Install |
|--------|------|---------|
| **Windows 10 / 11** | `Autobot-Terminal-Setup-<version>.exe` | Double-click it. No admin rights needed. |
| Windows, no install | `Autobot-Terminal-<version>-portable.exe` | Double-click it. |
| **Ubuntu 22.04 / 24.04** | `autobot-terminal_<version>_amd64.deb` | `sudo apt install ./autobot-terminal_<version>_amd64.deb` |
| **RHEL 8 / 9, Rocky, AlmaLinux** | `autobot-terminal-<version>.x86_64.rpm` | `sudo dnf install ./autobot-terminal-<version>.x86_64.rpm` |
| Other Linux (x86_64) | `Autobot-Terminal-<version>-x86_64.AppImage` | `chmod +x` it and run it |

The Windows installer is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC": choose
**More info**, then **Run anyway**.

Step-by-step guides: **[Windows](docs/INSTALL-WINDOWS.md)** and **[Linux](docs/INSTALL-LINUX.md)**.

## How it works

Autobot draws its own input line at the bottom of the window. You type there; your shell (PowerShell, cmd, bash, zsh,
or a WSL distro) only sees the command when you press Enter, and shows its output above. Everything else happens
before that moment, on your computer: suggestions, checks and warnings. Accepting a suggestion only changes the text
you are typing. Nothing is ever run for you.

It learns from three places: your own command history, what it knows about thousands of command-line tools (the
options, subcommands and examples that ship with it), and the tools installed on your machine, which it reads the
`--help` of the first time you use them. The more you use it, the better its suggestions get.

## Features

**Suggestions while you type**
- Gray ghost text completes the line from your history, ranked by the same folder first, then how often and how
  recently you ran it. On an empty line it predicts the command you usually run next.
- A dropdown offers commands, subcommands, options (with descriptions), option values, paths and variables. Your own
  habits rank first. Live values come from your machine: git branches and remotes, docker containers, npm scripts,
  make targets, ssh hosts, systemd units.
- `Ctrl+Space` opens a panel with everything known about the command: its options, examples and your history with it.

**Mistakes caught before Enter**
- Unknown commands ("did you mean"), unknown options and subcommands, an option missing its value, folders and files
  that don't exist, and plain syntax errors are underlined while you type. Red means certainly wrong, yellow means
  "not in what Autobot knows". `Alt+Enter` applies the suggested fix.
- Destructive commands (`rm -rf /`, `mkfs`, `dd` onto a disk, `Format-Volume`, shutdown ...) need a second Enter after
  a warning. Risky ones (`git push --force`, `curl ... | sh`) get a yellow note.

**Help after a failure**
- When a command fails, a banner says what to do next: the corrected command for a typo, `sudo` for a permission
  error, the install command for your distribution, git's own suggestion. The fix is also offered as ghost text.
- Optional AI help: press `Ctrl+.` after a failure and Claude (needs your API key) or a local Ollama model explains
  what went wrong and suggests a corrected command. It can also write short descriptions and examples for the tools
  you use. The AI never runs anything.

**Your shells**
- PowerShell 7, Windows PowerShell 5.1, Command Prompt, bash and zsh on Linux, and your WSL distros, in tabs.
  Multi-line commands, copy and paste, a coloured mark in the scrollback for every command (green ok, red failed).

**Inside ssh**
- A plain `ssh host` login gets the same suggestions, checks and path completion, from the other machine: its
  commands, its files and folders, its package manager, and its own history, kept apart from your local one. The
  prompt bar shows `user@host`. Nothing is installed on the other machine, and you are asked the first time.
  Works for bash and zsh accounts, from bash, zsh and PowerShell tabs.

**Colours**
- The command line is coloured while you type, and stays coloured in the scrollback: the command by what kind of
  program it is (looks at things, changes things, destroys things, `sudo`, git, package managers, containers and
  clouds, network, services), then subcommands, options, paths, URLs, quoted text and variables.
- Output is coloured by its words and shape: errors, warnings and successes, paths, URLs, IP addresses, times, numbers
  with units, HTTP status codes, and added or removed lines in a diff. Output that a program colours itself, and
  full-screen programs such as vim and less, keep their own colours. Both can be turned off in Settings.

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| Enter | Run. Inserts a newline instead if the command is unfinished (open quote, trailing pipe, open block ...). |
| Shift+Enter | Newline |
| → or End (at the end of the line) | Accept the gray ghost text |
| Ctrl+→ | Accept the next word of the ghost text |
| Tab | Accept the dropdown item; with the dropdown closed, complete in place or open the list |
| Ctrl+Space | Panel: options, examples and your history for the command being typed |
| Esc | Close the dropdown or panel; cancel a danger confirmation; dismiss a fix; hide the ghost text |
| Alt+Enter | Apply the fix for the problem shown under the input |
| Ctrl+. | Ask the AI how to fix the last failed command |
| Enter (twice) | Run a destructive command after reading the warning |
| ↑ / ↓ | Move in the dropdown or panel when open; otherwise history, newest first. With text typed, only entries that start with it. |
| Ctrl+C | Copy the selection, otherwise clear the line (at a prompt) or interrupt (while running) |
| Ctrl+V, Ctrl+Shift+C/V | Paste / copy / paste |
| Ctrl+L | Clear screen |
| Ctrl+Shift+T / Ctrl+Shift+W | New tab / close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |

## Settings

Click the **⚙** button in the tab bar for the ssh and colour settings, and **AI** to set up AI help. Everything else is
in `settings.json` (`%APPDATA%\autobot-terminal\` on Windows, `~/.config/autobot-terminal/` on Linux), applied as soon
as you save it:

| Setting | What it does |
|---------|--------------|
| `defaultProfile` | Shell for new tabs: `pwsh`, `powershell`, `cmd`, `bash`, `zsh`, `wsl:Ubuntu`, `wsl:Ubuntu:zsh`. `null` picks the first one found (on Linux: your login shell). |
| `theme`, `fontFamily`, `fontSize`, `scrollback`, `cursorBlink` | Looks. |
| `ghostText` | Gray suggestions from history while typing. |
| `dropdown` | Open the suggestion list automatically while typing. Tab and Ctrl+Space work either way. |
| `importHistory` | One-time import of your existing PowerShell / bash / zsh history. |
| `learnTools` | Learn tools you run by reading their `--help`. |
| `errorChecks` | Underline mistakes while typing and suggest fixes after failures. |
| `dangerConfirm` | Ask for a second Enter before destructive commands. |
| `sshIntegration` | `ask`, `on` or `off`: suggestions inside ssh sessions. |
| `colorCommands`, `colorOutput` | Colour the command line / the output. |
| `networkHelpers` | Tools whose live values may come from a remote service, e.g. `["kubectl"]` for namespaces and pods. Off by default. |
| `llmProvider` | `anthropic` (Claude, needs an API key), `ollama` (a local model) or `off`. |
| `llmModel`, `ollamaUrl`, `ollamaModel` | Which model to use. |
| `llmLearn`, `llmWebSearch`, `llmPanel`, `llmDailyLimit` | What the AI may do in the background, and how many background requests a day. |

The Claude API key is not a setting: paste it into the **AI** dialog. It is stored encrypted by your system (Windows
DPAPI, or the keyring on Linux), never as plain text. You can also set `ANTHROPIC_API_KEY` in your environment.

## History and privacy

Your history and what Autobot learned about your tools stay on your computer, next to `settings.json`
(`history.db` and `knowledge.db`). Delete them to start over. Each shell keeps its own history.

- **Saved:** each command you run from the input line, with its folder, exit code and duration.
- **Never saved:** commands that start with a space.
- **Masked before saving:** obvious secrets (`--password=...`, `TOKEN=...`, `Bearer ...`, `user:pass@` in URLs,
  GitHub, AWS, Anthropic and OpenAI-style keys). Masked commands are never offered as ghost text.
- **Imported once:** your existing PowerShell, bash and zsh history files. Nothing is written back to them.
- **Not sent anywhere,** unless you turn on AI help. Then `Ctrl+.` sends the failed command and its last 50 output
  lines with secrets masked and your home folder shown as `~`; background notes send tool and option names only,
  never your commands, scripts or arguments. With Ollama, nothing leaves your machine.
- **What it runs to learn:** only `--help`, `-h` and `--version` of real programs found on your PATH, with a time
  limit. Never scripts, graphical programs, or destructive and interactive tools (`rm`, `dd`, `mkfs`, `shutdown`,
  `sudo`, editors, pagers and the like).

## Known limits

- ssh: only plain interactive logins to a bash or zsh account get suggestions. A second ssh from the remote machine,
  `sudo -i`, `su` and containers entered there are plain shells. The server's "last login" line and message of the
  day are not shown. There are no git branches in the prompt bar and no live helpers for the remote machine.
- Command Prompt: a comment line (`rem`, `::`) or a line with an unclosed quote shows the previous command's exit
  code. `doskey` macros and cmd's own arrow-key history are not used.
- bash and zsh tabs read `~/.bashrc` / `~/.zshrc` but not login-only files such as `.profile`: put what the shell
  needs in the rc file.
- PowerShell multi-line input drops blank lines, which matters inside here-strings.
- Commands run in Autobot's PowerShell tabs are not added to PSReadLine's history file; they are in Autobot's own.
- Multi-line commands are in the ↑ history but are never offered as ghost text.
- On Linux desktops, `Ctrl+Space` may be taken by the input-method switcher; Tab still opens suggestions.
- Tools with unusual `--help` pages are learned partly or not at all (the built-in knowledge still works for them).

## Credits and license

Autobot Terminal is released under the [MIT License](LICENSE).

Its built-in knowledge is converted from other projects: tool specs from
[withfig/autocomplete](https://github.com/withfig/autocomplete) (MIT / ISC) and usage examples from
[tldr-pages](https://github.com/tldr-pages/tldr) (CC BY 4.0; the pages are by their contributors).
"Autobot" is a Hasbro trademark; this is an unrelated personal project.
