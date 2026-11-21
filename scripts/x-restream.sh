#!/usr/bin/env bash
# MediaMTX runOnReady hook: optionally restream the live path to X (RTMP).
# Not configured or misconfigured -> idle quietly instead of exiting, so runOnReadyRestart
# does not respawn this every few seconds (it used to log ~91k "Permission denied" lines/day:
# an X_RTMP_URL that was not an rtmp(s):// URL made ffmpeg write a file named after the key).
# Never prints the stream key: ffmpeg's own diagnostics are redacted before they reach the log.
set -u
raw="${X_RTMP_URL:-}"
key="${X_RTMP_KEY:-}"
url="${raw%/}"
if [ -z "$raw" ] || [ -z "$key" ]; then
  exec sleep infinity
fi
case "$url" in
  rtmp://*|rtmps://*) ;;
  *)
    echo "x-restream: X_RTMP_URL is not an rtmp:// or rtmps:// URL; restream disabled" >&2
    exec sleep infinity
    ;;
esac
exec ffmpeg -nostdin -loglevel error -i "rtsp://127.0.0.1:8554/${MTX_PATH}" -c copy -f flv "${url}/${key}" \
  2> >(KEY="$key" awk '{ while ((i = index($0, ENVIRON["KEY"])) > 0) $0 = substr($0, 1, i - 1) "***" substr($0, i + length(ENVIRON["KEY"])); print; fflush() }' >&2)
