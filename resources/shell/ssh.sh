# Autobot Terminal: wraps ssh so that a plain interactive login also gets Autobot's suggestions on the other
# machine. Sourced by the bash and zsh hooks. Autobot sets two variables for the tab:
#   AUTOBOT_SSH          ask (default), on or off
#   AUTOBOT_SSH_CMDFILE  a file holding the one-line command that starts a hooked shell on the remote machine
#   AUTOBOT_SSH_TOKEN    proves that an answer to the question below came from here and not from text some program printed
# The remote shell is started through ssh's RemoteCommand option, so nothing is installed over there and nothing
# is typed into the session after login. Whatever this file is not sure about runs the real ssh untouched.

# Succeeds when the arguments describe a plain interactive login: options and a host, nothing after the host.
__autobot_ssh_login() {
  local host= rest c
  while [ $# -gt 0 ]; do
    case $1 in
      --)
        shift
        [ $# -eq 1 ] && [ -z "$host" ] && return 0
        return 1
        ;;
      -?*)
        rest=${1#-}
        shift
        while [ -n "$rest" ]; do
          c=${rest%"${rest#?}"}
          rest=${rest#?}
          case $c in
            [NfnTsVGOQW]) return 1 ;; # no shell, or a different kind of request
            [BbcDEeFIiJLlmoPpRSw])    # takes a value, either attached or as the next argument
              if [ -z "$rest" ]; then
                [ $# -gt 0 ] || return 1
                shift
              fi
              rest=
              ;;
          esac
        done
        ;;
      *)
        [ -n "$host" ] && return 1 # a command follows the host
        host=$1
        shift
        ;;
    esac
  done
  [ -n "$host" ]
}

# Left alone as well, found out with `ssh -G` (which only prints the settings ssh would use, it connects to nothing):
# a RemoteCommand or "no terminal" in the user's own config, and the git account or git hosting services, which
# refuse a command and only greet you.
ssh() {
  if [ "${AUTOBOT_SSH:-ask}" = off ] || [ ! -r "${AUTOBOT_SSH_CMDFILE:-}" ] || [ ! -t 0 ] || [ ! -t 1 ] ||
    ! __autobot_ssh_login "$@" ||
    command ssh -G "$@" 2>/dev/null | grep -Eiq '^(remotecommand |sessiontype (none|subsystem)|requesttty no$|user git$|hostname (.+\.)?(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com)$)'; then
    command ssh "$@"
    return
  fi

  if [ "${AUTOBOT_SSH:-ask}" = ask ]; then
    local answer
    printf 'Autobot can suggest commands inside this ssh session. It sends a small helper along with the login,\n' >&2
    printf 'which lives only as long as the session; nothing is installed on the other machine.\n' >&2
    printf '  [y] yes   [n] not this time   [a] always   [v] never : ' >&2
    IFS= read -r answer
    case $answer in
      [yYaA]*) ;;
      [vV]*)
        AUTOBOT_SSH=off
        printf '\033]7777;P;SshChoice=off:%s\007' "${AUTOBOT_SSH_TOKEN:-}"
        command ssh "$@"
        return
        ;;
      *)
        command ssh "$@"
        return
        ;;
    esac
    case $answer in
      [aA]*)
        AUTOBOT_SSH=on
        printf '\033]7777;P;SshChoice=on:%s\007' "${AUTOBOT_SSH_TOKEN:-}"
        ;;
    esac
  fi

  command ssh -t -o "RemoteCommand=$(cat "$AUTOBOT_SSH_CMDFILE")" "$@"
}
