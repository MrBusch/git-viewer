# Features

This page lists what Git Viewer shows and what each action does. To install the app, see the [README](../README.md).

Git Viewer never commits, pushes, or resets. It deletes files or branches only through **Discard** and **Clean up**, after you confirm.

## Sidebar

The sidebar lists every repository Git Viewer knows about, with the branch its main folder is on. If a repository has more than one worktree, a number next to the branch shows how many.

- **+ Add** clones a repository from a URL, or adds a repository that's already on disk. See [Add your repositories](../README.md#add-your-repositories).

## Repository header

- **Fetched … ago** is the time of the last fetch.
- **Refresh** reloads the page's data. The page also refreshes every 30 seconds and when you return to its browser tab.
- **Fetch** runs `git fetch --all --prune`.
- **Remove from list** appears for repositories added by hand. It hides the repository and leaves its files alone.

## Worktrees tab

One row per worktree. The main folder is marked **main**.

| Column | Shows |
| --- | --- |
| Worktree / branch | Folder name and the branch checked out in it. |
| Changes | Counts of staged, modified, untracked, and conflicted files, or **clean**. Also shows a merge, rebase, cherry-pick, revert, or bisect in progress. |
| vs upstream | Commits ahead (↑) and behind (↓) the upstream branch. **upstream gone** means the remote branch was deleted. |
| vs default | Commits ahead and behind the default branch, for example `master`. |
| Last commit | Subject, hash, author, and age. Click the subject to see the full commit message. |

Click a row that has changes to expand it. The expanded row lists the changed files in groups: **Conflicts**, **Staged**, **Not staged**, and **Untracked**. Each file shows lines added and removed.

### Actions on a worktree

- **Pull ↓N** fast-forwards the branch to its upstream. It never creates a merge commit, and it's offered only when the branch has no commits of its own.
- **Switch…** switches the worktree to another local branch. A branch that's checked out in another worktree can't be picked.
- **Open in main…** checks out this worktree's branch in the main folder. See [Open a worktree's branch in the main folder](#open-a-worktrees-branch-in-the-main-folder).
- **Clean up…** appears when the upstream is gone. See [Clean up merged branches](#clean-up-merged-branches).
- **Copy path** copies the worktree's folder path.

## Changed files

- Click a file name to open its diff in a new browser tab. **Changes** shows the changed lines with three lines of context. **Full file** shows the whole file with the changes highlighted. A new file shows as all added lines.
- **Discard** asks for a second click within 3 seconds, then:

  | Group | Discard does |
  | --- | --- |
  | Not staged | Restores the file to its staged version, or to the last commit if nothing is staged. |
  | Staged | Restores the file to the last commit. A newly added file is deleted. |
  | Untracked | Deletes the file. |
  | Conflicts | Not available. Resolve conflicts in your editor. |

  Before it discards, Git Viewer copies the file to `~/.git-viewer/discarded/`. The message that confirms the discard has an **Undo** button for 12 seconds. Undo puts the content back as an unstaged change. Backups are deleted after 7 days.

## Local branches tab

One row per local branch, newest first. The columns match the Worktrees tab. Under the branch name, **checked out in** names the worktree that has it.

- **not tracked** means a remote branch with the same name exists, but the local branch doesn't track it. **Track** sets it as the upstream.
- An upstream with a different name than the branch is shown in full, for example `→ origin/master`.
- **Check out…** checks out the branch in an existing worktree or in a new one.
- **Pull ↓N**, **Open in main…**, and **Clean up…** work as on the Worktrees tab.

## Remote branches tab

One row per remote branch, newest first.

- The filter box matches branch names and authors.
- **Hide ones I have locally** hides remote branches that a local branch tracks or shares a name with.
- **Only *your name*** shows branches whose last commit is yours, by your `git config user.name`.
- **Check out…** creates a local branch that tracks the remote branch. You choose whether to open it in a new worktree, switch an existing worktree to it, or only create the branch.
- **Track** appears when a local branch with the same name exists. It sets the remote branch as that branch's upstream.

## Open a worktree's branch in the main folder

Git allows a branch in only one worktree at a time. **Open in main…** offers two ways to get a worktree's branch into the main folder:

- **Test a copy** checks out the branch's latest commit in the main folder, without the branch itself. The worktree keeps the branch, so work there continues. When the branch gets new commits, the banner offers **Update ↓N**. **Back to *branch*** returns the main folder to the branch it was on.
- **Move the branch** detaches the worktree, which keeps the same commit and files, and checks out the branch in the main folder. You can commit there. **Return branch** puts the main folder back on its previous branch and gives the branch back to the worktree.

While a branch is open in the main folder, a banner at the top of the repository shows the state and the way back.

## Clean up merged branches

**Clean up…** appears on branches whose remote branch was deleted. Under **upstream gone**, Git Viewer shows whether the work landed in the default branch:

- **merged ✓**: the branch's commits are in the default branch.
- **squash-merged ✓**: a commit in the default branch has the same combined change, as a GitHub squash merge produces.
- **not merged**: Git Viewer couldn't find the work.

The dialog deletes the worktree folder, the local branch, or both. Deleting the folder also deletes ignored files in it, such as `node_modules` and `.env`. You must type the branch name to confirm in two cases: the branch isn't merged, or the worktree has uncommitted or untracked files. The dialog lists the files you would lose.

Git Viewer won't delete the default branch, a branch checked out in the main folder, a branch that's open in the main folder, or a locked worktree.

## Where your data lives

Git Viewer stores nothing in its own folder. Each user's state lives in their home folder:

| Path | Holds |
| --- | --- |
| `~/.git-viewer/config.json` | Repositories added by hand, and branches open in the main folder. |
| `~/.git-viewer/discarded/` | Backups of discarded files, kept for 7 days. |

## Settings

Set these environment variables when you run `./start.sh`:

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3024` | Port the app listens on. |
| `GIT_VIEWER_ROOTS` | your home folder | Folders to scan for repositories, separated by colons. |
| `GIT_VIEWER_CONFIG` | `~/.git-viewer/config.json` | Path of the config file. |
| `GIT_VIEWER_BACKUPS` | `~/.git-viewer/discarded` | Folder for discard backups. |
