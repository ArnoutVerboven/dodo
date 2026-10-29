# dodo — GitHub

The agent works on GitHub repos through a **GitHub App** that dodo creates on your account. You pick which repos it may use; a project or task names the repo it works on; pushes and pull requests ask you first.

## Set up (two clicks, once)

1. **Settings › GitHub › Create the GitHub App.** GitHub shows "Create GitHub App for &lt;you&gt;" with the name and permissions filled in; press **Create**. (For an organization, type its name in the box first.) GitHub hands the app's id and private key straight back to dodo, which keeps them in Secret Manager (`dodo-github-app`, readable only by the `dodo-gateway` account). Nothing to copy by hand.
2. GitHub then asks where to **install** the app: choose **Only select repositories** and pick the repos the agent may work on. You land back in Settings with the list of repos.

Change the repos later with **Choose repos on GitHub** (dodo picks up the change on its own; **Refresh list** forces it). **Disconnect** forgets the installation in dodo; uninstall or delete the app itself on GitHub.

The app asks for: **Contents** read/write (clone, push branches), **Pull requests** read/write (open them), **Metadata** read. Not **Workflows**: the agent cannot change `.github/workflows`, which is where the deploy credentials are used. It has no webhooks.

## Repos per project and per task

The **Repo** field in a project's default AI settings or a task's AI settings picks from your connected repos (or takes any `owner/name`; public repos work without the app). The task's repo wins over the project's.

## What a run gets

- At the start of a run the worker asks the control plane (`githubToken`) for a **read token for that one repo**, valid for an hour, and clones it into the task folder with it. The token is passed to git for that command only; the checkout keeps no credentials, so a plain `git push` from bash fails. On a Mac with a folder that already holds the checkout, nothing is cloned.
- Commits are made as the app's bot account (`<app>[bot]`).
- The agent publishes with two tools:
  - `open_pull_request`: pushes HEAD to a branch and opens a pull request against the default branch (or returns the open one for that branch), and attaches its link to the task. Policy rule `GitHub(pr:owner/name)`.
  - `push_branch`: pushes more commits to a branch. Policy rule `GitHub(push:owner/name)`.
- Both are _outbound_, so they always ask unless an allow rule covers them. "Always allow" on the card adds the rule for the task, the project or everywhere. Neither tool pushes to the default branch.
- The control plane checks the approval again before it hands out a **write token** (contents only, that repo only) or opens the pull request: an allow rule at any scope, or an approval you answered yes on this task. A deny rule anywhere wins. Approving a pull request also covers its push.

## Code

- `packages/core/src/github.ts`: shared types, `repoFor`, `githubRule`.
- `apps/functions/src/github.ts`: manifest flow, install callback, repo sync, run tokens, pull requests (`githubConnect`, `githubCallback`, `githubSync`, `githubDisconnect`, `githubToken`, `githubOpenPr`).
- `packages/agent/src/github-tools.ts`: `push_branch`, `open_pull_request`.
- `apps/worker/src/run.ts`: checkout with the read token.
- `apps/web/src/components/GitHubSettings.tsx`: the Settings card.

Later: more than one repo per task, CI status and review comments as input for the agent, GitHub Issues as a task connector.
