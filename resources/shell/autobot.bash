# Autobot Terminal shell integration for bash (loaded with --rcfile).
# The GUI owns the input line; this hook only reports state back to it via OSC 7777 markers:
#   ESC]7777;A;<exit>;<cwd>BEL   prompt ready
#   ESC]7777;C BEL               command started
#   ESC]7777;P;<Key>=<Value>BEL  session property

# Behave like a normal interactive bash first.
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

case $- in
  *i*) ;;
  *) return ;;
esac

__autobot_status=0

__autobot_precmd() {
  __autobot_status=$?
  # Hand the real exit status on to any PROMPT_COMMAND the user configured.
  return $__autobot_status
}

__autobot_postcmd() {
  # Runs last so it wins over prompt frameworks that rewrite PS1 every time.
  PS1=''
  PS2=''
  # If output did not end with a newline, mark it with a dim % and start a fresh line (zsh's PROMPT_SP trick).
  printf '\033[2;7m%%\033[0m%*s\r\033[K' "$(( ${COLUMNS:-80} - 1 ))" ''
  printf '\033]7777;A;%s;%s\007' "$__autobot_status" "$PWD"
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__autobot_precmd "${PROMPT_COMMAND[@]}" __autobot_postcmd)
else
  PROMPT_COMMAND="__autobot_precmd"$'\n'"${PROMPT_COMMAND:-:}"$'\n'"__autobot_postcmd"
fi

PS0='\e]7777;C\a'
shopt -s checkwinsize

# Commands starting with a space stay out of history (Autobot follows the same rule).
case ":${HISTCONTROL}:" in
  *:ignorespace:* | *:ignoreboth:*) ;;
  *) HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac

# Multi-line commands arrive as a bracketed paste; do not highlight pasted text.
bind 'set enable-bracketed-paste on' 2>/dev/null
bind 'set enable-active-region off' 2>/dev/null

# Command and variable names for completion, written once per session for Autobot to read (and delete).
# The command list is built in a detached background subshell (no job messages, never delays the prompt)
# and skips Windows folders that WSL appends to PATH: listing those over /mnt/c takes many seconds.
__autobot_state="${TMPDIR:-/tmp}/autobot-$$"
( (
  PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)
  compgen -c 2>/dev/null | sort -u >"$__autobot_state.commands.tmp" &&
    mv -f "$__autobot_state.commands.tmp" "$__autobot_state.commands"
) >/dev/null 2>&1 & )
printf '\033]7777;P;Commands=%s\007' "$__autobot_state.commands"
if compgen -v >"$__autobot_state.vars" 2>/dev/null; then
  printf '\033]7777;P;Variables=%s\007' "$__autobot_state.vars"
fi
unset __autobot_state

printf '\033]7777;P;Home=%s\007' "$HOME"
printf '\033]7777;P;Shell=bash %s\007' "${BASH_VERSION%%(*}"

# Lets Autobot offer a zsh tab for this machine (for WSL distros, which it cannot look into without starting them).
if __autobot_zsh=$(command -v zsh 2>/dev/null) && [ -n "$__autobot_zsh" ]; then
  printf '\033]7777;P;Zsh=%s\007' "$__autobot_zsh"
fi
unset __autobot_zsh

# Suggestions inside ssh sessions (the ssh wrapper).
[ -r "${BASH_SOURCE[0]%/*}/ssh.sh" ] && . "${BASH_SOURCE[0]%/*}/ssh.sh"
