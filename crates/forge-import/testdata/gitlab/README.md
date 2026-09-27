# GitLab fixtures

Recorded 2026-09-27 from gitlab.com, anonymously, and trimmed to the fields forge-import reads.

- `project.json`, `issues.json`, `merge_requests.json`: `gitlab-org/gitlab-runner-docker-cleanup` (project 444821).
  - `merge_requests.json` is all six of its merge requests:
    - `!1` is merged, and its source project was deleted (`source_project_id: null`).
    - `!2`, `!3`, `!4` and `!6` are closed fork merge requests.
    - `!5` is open, from a branch of the project.
  - `issues.json` is the first page of three issues (`per_page=3`).
- `ls-remote-mr-heads.txt`: `git ls-remote <project>.git 'refs/merge-requests/*/head'` at the same time. Only `!5`'s head is left; GitLab deletes a head 14 days after its merge request closes or merges.
- `releases.json`: the latest release of `gitlab-org/cli`, with two asset links.

Notes, discussions and labels answer `401 Unauthorized` without a token, on gitlab.com and on the self-hosted instances tried (`salsa.debian.org`, `gitlab.torproject.org`, `invent.kde.org`, `code.videolan.org`, `gitlab.xfce.org`). So their fixtures are the example responses in GitLab's API documentation (docs.gitlab.com/api/discussions/ and docs.gitlab.com/api/notes/, CC BY-SA 4.0), with ids and dates as published, attached to the recorded items:

- `mr-5-discussions.json`: the documented thread, individual note and DiffNote.
- `issue-2-notes.json`: the documented issue notes, plus a system note and an internal note. Neither of those two is mirrored.
