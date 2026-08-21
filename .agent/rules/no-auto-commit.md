---
description: Git commit & push safety
globs:
alwaysApply: true
---

# No automatic commits

- NEVER run `git commit`, `git push`, `git merge`, `git rebase`, or any other
  history-changing git command unless the user explicitly asks for it in that
  same request.
- Do not "helpfully" commit or push finished work. Leave changes in the working
  tree for the user to review.
- If you think a commit is warranted, ask first and wait for explicit
  confirmation before running it.
- Applies to this repository in particular: the GitHub remote is **public** and
  the working tree holds the shop's production catalogue export, so a commit is
  not a cheap, local, reversible action here.
