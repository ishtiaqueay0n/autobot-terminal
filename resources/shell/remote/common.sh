# Autobot Terminal: the part of the remote hook that bash and zsh share (placed in front of each one's hook).
# Autobot types "__autobot_rpc <id> <op> <base64 argument>" at an idle remote prompt, with a leading space so it
# stays out of the history, and reads the answer from the marker this prints. Only reads; nothing is changed.
__autobot_b64() {
  base64 | tr -d '\n'
}

__autobot_rpc() {
  local p out
  p=$(printf %s "$3" | base64 -d 2>/dev/null)
  case $2 in
    ls)
      if [ -d "$p" ] && [ -r "$p" ] && [ -x "$p" ]; then
        out="ok"$'\n'$(ls -1Ap -- "$p" 2>/dev/null | head -n 5000)
      else
        out=no
      fi
      ;;
    stat)
      if [ -d "$p" ]; then out=d; elif [ -e "$p" ]; then out=f; else out=-; fi
      ;;
    *) out=no ;;
  esac
  printf '\033]7777;Q;%s;%s\007' "$1" "$(printf %s "$out" | __autobot_b64)"
}

# What this machine is (for package-manager advice) and where the user's files are.
__autobot_host="${HOSTNAME:-${HOST:-$(uname -n)}}"
__autobot_who="${USER:-$(id -un 2>/dev/null)}@${__autobot_host%%.*}"
unset __autobot_host
if [ -r /etc/os-release ]; then
  printf '\033]7777;P;RemoteOs=%s\007' "$(__autobot_b64 </etc/os-release)"
fi
printf '\033]7777;P;RemoteHome=%s\007' "$HOME"
