#!/bin/sh
# Started by the worker (root) in place of Chromium, see apps/worker/src/headless.ts.
# Hands the profile folder Playwright just made to the browser user, then runs Chromium as that
# user: a page that breaks out of the renderer lands as `browser`, which cannot read the worker's
# environment (the run's credential), its memory, or the task folder.
set -eu
: "${DODO_CHROMIUM:?}" "${DODO_BROWSER_UID:?}" "${DODO_BROWSER_GID:?}"
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) chown -R "$DODO_BROWSER_UID:$DODO_BROWSER_GID" "${a#--user-data-dir=}" ;;
  esac
done
exec setpriv --reuid="$DODO_BROWSER_UID" --regid="$DODO_BROWSER_GID" --clear-groups \
  --inh-caps=-all --bounding-set=-all -- "$DODO_CHROMIUM" "$@"
