# Autobot Terminal shell integration for bash on a machine reached over SSH. The local ssh wrapper (ssh.sh) sends
# this file along with the login and loads it with --rcfile, so nothing is installed on the remote machine and
# this file deletes itself first thing. It reports state through the same OSC 7777 markers as autobot.bash, plus:
#   ESC]7777;R;<user@host>;bash BEL   the prompt that follows belongs to this remote shell
#   ESC]7777;Q;<id>;<base64> BEL      answer to a request Autobot typed (see __autobot_rpc below)
rm -rf "$AUTOBOT_DIR"
unset AUTOBOT_DIR

# --rcfile replaces what a login shell would read, so read it here: /etc/profile, then the first of three.
[ -r /etc/profile ] && . /etc/profile
for __autobot_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__autobot_f" ]; then . "$__autobot_f"; break; fi
done
unset __autobot_f
logout() { exit; }

__autobot_status=0

__autobot_precmd() {
  __autobot_status=$?
  return $__autobot_status
}

__autobot_postcmd() {
  PS1=''
  PS2=''
  printf '\033[2;7m%%\033[0m%*s\r\033[K' "$(( ${COLUMNS:-80} - 1 ))" ''
  printf '\033]7777;R;%s;bash\007\033]7777;A;%s;%s\007' "$__autobot_who" "$__autobot_status" "$PWD"
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__autobot_precmd "${PROMPT_COMMAND[@]}" __autobot_postcmd)
else
  PROMPT_COMMAND="__autobot_precmd"$'\n'"${PROMPT_COMMAND:-:}"$'\n'"__autobot_postcmd"
fi

PS0='\e]7777;C\a'
shopt -s checkwinsize

case ":${HISTCONTROL}:" in
  *:ignorespace:* | *:ignoreboth:*) ;;
  *) HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac

bind 'set enable-bracketed-paste on' 2>/dev/null
bind 'set enable-active-region off' 2>/dev/null

# Folders that WSL appends to PATH (/mnt/...) are left out: listing them takes many seconds.
printf '\033]7777;P;RemoteCommands=%s\007' "$(PATH=$(printf %s "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -); compgen -c 2>/dev/null | sort -u | __autobot_b64)"
printf '\033]7777;P;RemoteVariables=%s\007' "$(compgen -v 2>/dev/null | sort -u | __autobot_b64)"
printf '\033]7777;P;RemoteShell=bash %s\007' "${BASH_VERSION%%(*}"
