# Temporary files — use `.tmp/` inside the workspace, never `/tmp`

Write EVERY temporary, scratch, or intermediate file to a `.tmp/` folder at the **workspace root**
(`.tmp/…`, workspace-relative, no leading slash). Never write to `/tmp`, `/var/tmp`, or any other
location outside the workspace.

**Why:** files outside the workspace trigger a read/edit approval prompt on every access, which
stalls the task. A `.tmp/` folder inside the workspace is covered by the normal workspace file
permissions, so scratch work proceeds without interruption. `.tmp/` is git-ignored, so nothing in it
is ever committed.

This is for genuine scratch only — continuation prompts, review dumps, intermediate command output,
working notes, throwaway scripts. It does NOT change where real deliverables go: a milestone's
canonical plan still lives at `plans/milestone-<N>-<desc>.md`, and committed artifacts follow the
locations in `CLAUDE.md`. Never `git add` anything under `.tmp/` (it is git-ignored, so it will not
be staged by accident — do not force-add it).

Create the folder on first use if it does not exist (e.g. `mkdir -p .tmp`).
