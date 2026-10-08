# Autobot Terminal shell integration for zsh, part 1 of 2. Autobot starts zsh with ZDOTDIR pointing at this
# folder, so zsh reads these files instead of the user's. This one runs the user's own .zshenv and then makes
# sure zsh still reads our .zshrc next (the user's .zshenv may move ZDOTDIR, as people do for ~/.config/zsh).
# The user's real ZDOTDIR is in AUTOBOT_USER_ZDOTDIR (empty: their home folder).

__autobot_zdir="$ZDOTDIR"
AUTOBOT_USER_ZDOTDIR="${AUTOBOT_USER_ZDOTDIR:-$HOME}"
[[ -r "$AUTOBOT_USER_ZDOTDIR/.zshenv" ]] && source "$AUTOBOT_USER_ZDOTDIR/.zshenv"
[[ "$ZDOTDIR" != "$__autobot_zdir" ]] && AUTOBOT_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__autobot_zdir"
unset __autobot_zdir
# Shells started by commands that run later (scripts, nested zsh) must use the user's files, not ours.
[[ -o interactive ]] || ZDOTDIR="$AUTOBOT_USER_ZDOTDIR"
