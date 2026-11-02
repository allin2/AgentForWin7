#!/usr/bin/env bash
# Entry point for background jobs on a work-package machine. See box_job.py and design r4 section 4.1.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# env.sh puts the pinned Node on PATH; box_job.py then gives each job its own TMPDIR.
if [[ -f "$here/env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$here/env.sh"
fi
exec python3 -I "$here/box_job.py" "$@"
