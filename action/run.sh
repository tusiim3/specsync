#!/usr/bin/env bash
# Runs SpecSync for the GitHub Action. Inputs arrive as INPUT_* env vars.
set -uo pipefail

SPECSYNC=(node "$SPECSYNC_ACTION_PATH/dist/bin.js")
OUT="${RUNNER_TEMP:-/tmp}/specsync"
mkdir -p "$OUT"
export SPECSYNC_MODEL_CACHE="${SPECSYNC_MODEL_CACHE:-$HOME/.cache/specsync-models}"

args=()
[[ -n "${INPUT_CONFIG:-}" ]] && args+=(--config "$INPUT_CONFIG")
if [[ -n "${INPUT_SPEC:-}" ]]; then
  read -ra specs <<< "$INPUT_SPEC"
  args+=(--spec "${specs[@]}")
fi
[[ -n "${INPUT_REPO:-}" ]] && args+=(--repo "$INPUT_REPO")
[[ -n "${INPUT_PROVIDER:-}" ]] && args+=(--provider "$INPUT_PROVIDER")
[[ -n "${INPUT_MODEL:-}" ]] && args+=(--model "$INPUT_MODEL")

check_args=()
[[ -n "${INPUT_MIN_SCORE:-}" ]] && check_args+=(--min-score "$INPUT_MIN_SCORE")
[[ -n "${INPUT_FAIL_ON:-}" ]] && check_args+=(--fail-on "$INPUT_FAIL_ON")

# Share one cache between the base and head runs: unchanged requirements are judged once.
CACHE_DIR="$PWD/.specsync/cache"
TOP="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REL="$(realpath --relative-to="$TOP" "$PWD")"

link_args=()
if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${HEAD_SHA:-}" ]]; then
  base_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$HEAD_SHA/"
  [[ "$REL" != "." ]] && base_url="$base_url$REL/"
  link_args=(--link-base "$base_url")
fi

baseline_args=()
if [[ "${INPUT_COMPARE_BASE:-true}" == "true" && -n "${BASE_SHA:-}" ]]; then
  echo "::group::SpecSync on the base commit ${BASE_SHA:0:7}"
  rm -rf "$OUT/base"
  if git fetch --no-tags --depth=1 origin "$BASE_SHA" >/dev/null 2>&1 \
    && git worktree add --detach "$OUT/base" "$BASE_SHA" >/dev/null 2>&1 \
    && (cd "$OUT/base/$REL" && "${SPECSYNC[@]}" run "${args[@]}" --cache-dir "$CACHE_DIR" --no-history \
          --json "$OUT/base.json" --format json > /dev/null); then
    baseline_args=(--baseline "$OUT/base.json")
  else
    echo "::warning::SpecSync could not analyze the base commit, so the report has no comparison."
  fi
  git worktree remove --force "$OUT/base" >/dev/null 2>&1 || true
  echo "::endgroup::"
fi

sarif_args=()
[[ -n "${INPUT_SARIF:-}" ]] && sarif_args=(--sarif "$INPUT_SARIF")

"${SPECSYNC[@]}" check "${args[@]}" "${check_args[@]}" "${baseline_args[@]}" "${link_args[@]}" "${sarif_args[@]}" \
  --cache-dir "$CACHE_DIR" --no-history \
  --json "$OUT/report.json" --md "$OUT/report.md" --comment-md "$OUT/comment.md"
code=$?

score=""
if [[ -f "$OUT/report.json" ]]; then
  score="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.score===null?"":String(r.score))' "$OUT/report.json")"
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && cat "$OUT/report.md" >> "$GITHUB_STEP_SUMMARY"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "exit-code=$code"
    echo "score=$score"
    echo "report-json=$OUT/report.json"
    echo "report-markdown=$OUT/report.md"
    echo "comment-file=$OUT/comment.md"
  } >> "$GITHUB_OUTPUT"
fi
exit 0
