#!/usr/bin/env bash
# Download the ONNX models required by the `ocrs` engine into the user-level cache directory.
#
# Models come from the upstream mirror published by the maintainer of `ocrs`
# (https://github.com/robertknight/ocrs-models). Total download size is ~50 MB.
#
# Usage:
#   ./scripts/fetch-ocr-models.sh             # default destination
#   VIBE_MODELS_DIR=/tmp/models ./scripts/fetch-ocr-models.sh
#
# Exit codes: 0 on success, 1 if curl is missing, 2 if any download failed.

set -euo pipefail

DEST_DEFAULT="${HOME}/.cache/vibe-term/models"
DEST="${VIBE_MODELS_DIR:-${DEST_DEFAULT}}"

DETECTION_URL="https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten"
RECOGNITION_URL="https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten"

if ! command -v curl >/dev/null 2>&1; then
  echo "error: 'curl' is required but not installed." >&2
  exit 1
fi

mkdir -p "${DEST}"
cd "${DEST}"

download_one() {
  local url="$1"
  local name
  name="$(basename "${url}")"
  if [[ -f "${name}" && -s "${name}" ]]; then
    echo "==> ${name} already present ($(du -h "${name}" | cut -f1)), skipping"
    return 0
  fi
  echo "==> downloading ${name} from ${url}"
  if ! curl -L --fail --progress-bar -o "${name}.partial" "${url}"; then
    rm -f "${name}.partial"
    echo "error: download failed for ${name}" >&2
    return 2
  fi
  mv "${name}.partial" "${name}"
  echo "==> saved ${name} ($(du -h "${name}" | cut -f1))"
}

status=0
download_one "${DETECTION_URL}"   || status=$?
download_one "${RECOGNITION_URL}" || status=$?

if [[ "${status}" -ne 0 ]]; then
  echo "error: one or more models failed to download (status=${status})." >&2
  exit 2
fi

echo "==> OCR models ready in ${DEST}"
