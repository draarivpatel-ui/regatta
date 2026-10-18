#!/bin/sh
# Stand-in for a coding-agent CLI in the end-to-end tests: claude, codex, gemini, grok, cursor-agent,
# aider, opencode, qwen and amp all point here (see common.sh). It never starts the real tool and never
# calls any AI service: "--version" prints a fixed version, anything else runs the fake agent
# (scripts/fake-agent.mjs) with the same arguments.
. "$(dirname "$(readlink "$0")")/common.sh"
standin_log "$@"
if [ "$1" = "--version" ]; then
  echo "0.0.0 (e2e stand-in)"
  exit 0
fi
exec node "$standin_dir/../../fake-agent.mjs" "$@"
