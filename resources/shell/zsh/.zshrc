# Autobot Terminal shell integration for zsh, part 2 of 2 (see .zshenv). The GUI owns the input line; this hook
# only reports state back to it via OSC 7777 markers:
#   ESC]7777;A;<exit>;<cwd>BEL   prompt ready
#   ESC]7777;C BEL               command started
#   ESC]7777;P;<Key>=<Value>BEL  session property

# Where this file is: the ssh wrapper sits one folder up (read before the user's files may change anything).
__autobot_ssh="${${(%):-%x}:A:h:h}/ssh.sh"

# Behave like a normal interactive zsh first: from here on ZDOTDIR is the user's again.
ZDOTDIR="${AUTOBOT_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
unset AUTOBOT_USER_ZDOTDIR

typeset -g __autobot_status=0

# Runs first among the precmd hooks, while $? is still the exit status of the command that just ran.
__autobot_status() {
  __autobot_status=$?
}

# Runs last, so it wins over prompt frameworks (oh-my-zsh, powerlevel10k) that rewrite PROMPT every time.
__autobot_precmd() {
  PROMPT=''
  PS1=''
  PS2=''
  RPROMPT=''
  RPS1=''
  printf '\e]7777;A;%s;%s\a' "$__autobot_status" "$PWD"
}

__autobot_preexec() {
  printf '\e]7777;C\a'
}

precmd_functions=(__autobot_status $precmd_functions __autobot_precmd)
preexec_functions+=(__autobot_preexec)

# Multi-line commands arrive as a bracketed paste; do not highlight pasted text.
zle_highlight=(paste:none)

# Command and variable names for completion, written once per session for Autobot to read (and delete). Built in
# a detached background subshell (no job messages, never delays the prompt); folders that WSL appends to PATH
# (/mnt/...) are skipped because listing them takes many seconds.
__autobot_state="${TMPDIR:-/tmp}/autobot-$$"
(
  (
    path=( ${path:#/mnt/*} )
    hash -r
    print -rl -- ${(ko)commands} ${(ko)aliases} ${(ko)functions:#_*} ${(ko)builtins} ${(ko)reswords} 2>/dev/null |
      sort -u >"$__autobot_state.commands.tmp" &&
      mv -f "$__autobot_state.commands.tmp" "$__autobot_state.commands"
  ) >/dev/null 2>&1 &!
)
printf '\e]7777;P;Commands=%s\a' "$__autobot_state.commands"
if print -rl -- ${(ko)parameters} >"$__autobot_state.vars" 2>/dev/null; then
  printf '\e]7777;P;Variables=%s\a' "$__autobot_state.vars"
fi
unset __autobot_state

printf '\e]7777;P;Home=%s\a' "$HOME"
printf '\e]7777;P;Shell=zsh %s\a' "$ZSH_VERSION"

# Suggestions inside ssh sessions (the ssh wrapper).
[[ -r "$__autobot_ssh" ]] && source "$__autobot_ssh"
unset __autobot_ssh
