#!/bin/sh
# Stand-in for ssh in the end-to-end tests. ssh finds "~" through the system's user database, not through
# HOME, so a fake home folder alone would not stop it reading the real ~/.ssh/config. This runs the real
# /usr/bin/ssh with -F pointing at the config in the world's fake home (or an empty one when there is
# none), so nothing of the user's is read. The arguments are the app's, unchanged.
. "$(dirname "$(readlink "$0")")/common.sh"
standin_log "$@"
config="$standin_world/home/.ssh/config"
[ -f "$config" ] || config=/dev/null
exec /usr/bin/ssh -F "$config" "$@"
