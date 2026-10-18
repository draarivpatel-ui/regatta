#!/bin/sh
# Stand-in for a service CLI in the end-to-end tests: gh, glab, stripe, wrangler, supabase and vercel
# all point here (see common.sh). It never talks to any service. The version arguments ("--version", or
# the bare word "version" that stripe uses) print a fixed version; every other command, such as
# "auth status" or "whoami", says it is not signed in and exits 1.
. "$(dirname "$(readlink "$0")")/common.sh"
standin_log "$@"
case "$*" in
  --version | version)
    echo "0.0.0 (e2e stand-in)"
    exit 0
    ;;
esac
echo "not signed in" >&2
exit 1
