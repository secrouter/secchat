#!/usr/bin/env bash
# callrec — record yourself, send it to the SecChat voice backend for transcription, and
# (optionally) store your voiceprint on the server so you're identified in this and future
# recordings.
#
# It talks to SecRecorder — the suite's transcription + speaker-recognition service
# (POST /v1/audio/transcriptions and POST /v1/speakers/from-audio). Audio is captured locally
# with ffmpeg and posted over the suite's fronted HTTPS; nothing is stored on disk unless you
# ask (--keep). This is the single-user path (record → transcribe → optional ID enrollment); it
# does NOT place a WebRTC call through mediad — that relay is only needed for a live 2-party call.
#
# Examples:
#   scripts/callrec.sh                         # record until Enter, print the transcript
#   scripts/callrec.sh -s 8                    # record 8 seconds
#   scripts/callrec.sh --enroll "Austin"       # record + store my voiceprint under "Austin"
#   scripts/callrec.sh --identify              # record + label diarized speakers from enrolled voiceprints
#   scripts/callrec.sh -i memo.wav             # transcribe an existing audio file (no mic)
#   scripts/callrec.sh --list-mics             # list capture devices, then exit
set -euo pipefail

URL="https://secrecorder.sec.internal"
MIC=":0"                       # macOS avfoundation audio device index (":0" = default input)
SECONDS_ARG=""                 # fixed duration; empty = record until Enter
INPUT=""                       # transcribe this file instead of recording
ENROLL=""                      # also enroll the recording as this speaker name
IDENTIFY=0                     # match diarized speakers against enrolled voiceprints
DIARIZE=true                   # per-speaker labels in the transcript
KEEP=""                        # save the recording here instead of a temp file
CACERT=""                      # CA bundle for TLS (default: system trust; auto-detects suite CA)
INSECURE=0

die() { echo "callrec: $*" >&2; exit 1; }
usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--seconds)  SECONDS_ARG="${2:?}"; shift 2 ;;
    -i|--input)    INPUT="${2:?}"; shift 2 ;;
    -u|--url)      URL="${2:?}"; shift 2 ;;
    --mic)         MIC="${2:?}"; shift 2 ;;
    --enroll)      ENROLL="${2:?}"; shift 2 ;;
    --identify)    IDENTIFY=1; shift ;;
    --no-diarize)  DIARIZE=false; shift ;;
    -o|--keep)     KEEP="${2:?}"; shift 2 ;;
    --cacert)      CACERT="${2:?}"; shift 2 ;;
    -k|--insecure) INSECURE=1; shift ;;
    --list-mics)   exec ffmpeg -hide_banner -f avfoundation -list_devices true -i "" ;;
    -h|--help)     usage 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

command -v curl >/dev/null || die "curl not found"

# TLS: prefer the caller's --cacert, else the suite CA next to this checkout, else system trust
# (the suite root is normally trusted in the login keychain, so plain HTTPS just works).
if [ -z "$CACERT" ] && [ "$INSECURE" = 0 ]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  for cand in "$here/../../../out/seccert-root.pem" "$here/../../out/seccert-root.pem"; do
    [ -f "$cand" ] && { CACERT="$cand"; break; }
  done
fi
CURL=(curl -sS --fail-with-body)
[ -n "$CACERT" ] && CURL+=(--cacert "$CACERT")
[ "$INSECURE" = 1 ] && CURL+=(--insecure)

# ── 1. Get some audio (record the mic, or use --input) ──────────────────────────────────────
cleanup_wav=""
if [ -n "$INPUT" ]; then
  [ -f "$INPUT" ] || die "no such file: $INPUT"
  WAV="$INPUT"
else
  command -v ffmpeg >/dev/null || die "ffmpeg not found — needed to record the mic (brew install ffmpeg), or pass --input FILE"
  if [ -n "$KEEP" ]; then WAV="$KEEP"; else WAV="$(mktemp -t callrec).wav"; cleanup_wav="$WAV"; fi
  # 16 kHz mono is whisper's native rate — smaller upload, no quality loss for speech.
  FF=(ffmpeg -hide_banner -loglevel error -nostdin -f avfoundation -i "$MIC" -ac 1 -ar 16000 -y "$WAV")
  if [ -n "$SECONDS_ARG" ]; then
    echo "● recording ${SECONDS_ARG}s from mic $MIC …" >&2
    "${FF[@]}" -t "$SECONDS_ARG"
  else
    "${FF[@]}" & ffpid=$!
    printf '● recording from mic %s — press Enter to stop…' "$MIC" >&2
    read -r _ || true
    kill -INT "$ffpid" 2>/dev/null || true
    wait "$ffpid" 2>/dev/null || true
  fi
  [ -s "$WAV" ] || die "recording produced no audio (try a different --mic; see --list-mics)"
fi
trap '[ -n "$cleanup_wav" ] && rm -f "$cleanup_wav"' EXIT

# ── 2. Optional: enroll this sample as the caller's voiceprint (store embedding for ID) ──────
if [ -n "$ENROLL" ]; then
  echo "▸ enrolling voiceprint as \"$ENROLL\" …" >&2
  enroll_resp="$("${CURL[@]}" -X POST -F "file=@$WAV" -F "name=$ENROLL" "$URL/v1/speakers/from-audio")" \
    || die "enroll failed: $enroll_resp"
  ENROLL_RESP="$enroll_resp" python3 <<'PY' 2>/dev/null || echo "  ✓ enrolled: $enroll_resp"
import json, os
d = json.loads(os.environ["ENROLL_RESP"])
samples = d.get("samples", d.get("sample_count", "?"))
print("  ✓ enrolled %r  id=%s  samples=%s  (speakers in sample: %s)"
      % (d.get("name"), d.get("id"), samples, d.get("speakers_in_sample", "?")))
PY
fi

# ── 3. Transcribe (diarized; identify against enrolled voiceprints when asked) ──────────────
echo "▸ transcribing …" >&2
form=(-F "file=@$WAV" -F "diarize=$DIARIZE")
[ "$IDENTIFY" = 1 ] && form+=(-F "identify=true")
resp="$("${CURL[@]}" -X POST "${form[@]}" "$URL/v1/audio/transcriptions")" \
  || die "transcription failed: $resp"

RESP="$resp" python3 <<'PY' 2>/dev/null || { echo "raw response:"; echo "$resp"; }
import json, os
d = json.loads(os.environ["RESP"])
print("\n── transcript ─────────────────────────────────────────────")
print((d.get("text") or "(empty)").strip())
spk = d.get("speakers") or []
if spk:
    print("\n── speakers ───────────────────────────────────────────────")
    for s in spk:
        label = s.get("id") or s.get("speaker")
        who = s.get("name") or label or "?"
        secs = s.get("talk_time", s.get("seconds"))
        parts = ["  " + str(who)]
        if s.get("name") and label:
            parts.append("[%s]" % label)
        if secs is not None:
            parts.append("%.1fs" % float(secs))
        if s.get("match_score") is not None:
            parts.append("match=%.2f" % float(s["match_score"]))
        print("  ".join(parts))
print()
PY
