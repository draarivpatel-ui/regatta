# Shared by every stand-in in this folder (sourced, never run on its own).
#
# lib.mjs symlinks each stand-in script into <world>/bin under the name of the command it replaces, so
# $0 is <world>/bin/<command>: the file name is the command and the world folder is one level up.
# Every call is appended to <world>/standins.log as one line, "<command> <arguments>", written in a
# single call so stand-ins that run in parallel never mix their lines.

case "$0" in
  /*) standin_self="$0" ;;
  *) standin_self="$PWD/$0" ;;
esac
standin_name=$(basename "$standin_self")
standin_world=$(dirname "$(dirname "$standin_self")")
standin_dir=$(dirname "$(readlink "$standin_self")")

standin_log() {
  line="$standin_name"
  for arg in "$@"; do
    line="$line $arg"
  done
  line=$(printf '%s' "$line" | tr '\n\r' '  ')
  { printf '%s\n' "$line" >> "$standin_world/standins.log"; } 2>/dev/null
}
