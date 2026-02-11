---
name: release-ci-flow
description: Run a safe branch to PR to CI to merge to tag to GitHub Release workflow. Use when publishing versions or preparing release notes in GitHub-hosted repositories.
---

# Release CI Flow

Use this skill when the user wants a reliable release process with GitHub Actions checks as a gate before merge.

## Inputs you must confirm

- Target branch name (default `main`)
- Next version tag (for example `v1.1`)
- Merge style (`squash` preferred unless the user says otherwise)
- Whether branch protection requires passing checks

## Standard flow

1. Create a working branch from up-to-date main.

   ```bash
   git switch main
   git pull origin main
   git switch -c <topic-branch>
   ```

2. Implement change and run project tests locally.

   ```bash
   npm test
   ```

3. Commit and push branch.

   ```bash
   git add <files>
   git commit -m "<clear message>"
   git push -u origin <topic-branch>
   ```

4. Open a pull request to `main` and wait for CI checks.

- If checks fail, fix on the same branch and push again.
- If checks pass, merge with `Squash and merge` unless user requests another method.

5. Sync local main after merge.

   ```bash
   git switch main
   git pull origin main
   ```

6. Create and push annotated tag.

   ```bash
   git tag -a <version-tag> -m "<release summary>"
   git push origin <version-tag>
   ```

7. Create GitHub Release from the tag.

- Keep release notes short and user-visible.
- Mention key behavior changes, operational changes (CI/protection), and compatibility notes.

## Quick recovery playbook

- Wrong local tag only:

  ```bash
  git tag -d <version-tag>
  ```

- Wrong local + remote tag:

  ```bash
  git tag -d <version-tag>
  git push origin :refs/tags/<version-tag>
  ```

- Then recreate the correct tag and push again.

## Quality bar

Before tagging, ensure:

- CI check on the merge commit is green.
- `main` is protected from force push and direct unreviewed writes.
- Release notes do not mention internal milestone labels that public users cannot interpret.
