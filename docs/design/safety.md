# Design: safety of the engines that touch the user's repository

Heats, hand-offs, night watch, flows, checkpoints and storage cleanup create worktrees and branches,
merge into the user's branch, restore files, and move finished worktrees into Regatta's trash. This page fixes the threat model
those engines are built and reviewed against, the bar they must meet, and the mechanisms they share.

## Threat model

**In scope** (ordinary concurrent use; the engines must stay safe while it happens):
- The user runs normal git commands on their own branches at any time: commit, checkout or switch
  (including checking out a Regatta lane branch and committing on it), merge, rebase, stash,
  rename or delete branches, edit `.gitignore`.
- The user edits, creates, renames and deletes files in their project and in Regatta's **lane worktrees**
  (the worktrees a heat, hand-off or night task works in, which the user can open in a pane), runs
  git commands in them (commit, detach, rebase), and leaves programs running in them.
- Agents run arbitrary commands inside their folders, including servers and background jobs that
  detach or start their own process groups or sessions.
- Repository shapes: subfolders opened as the project, linked worktrees, case-insensitive file
  systems, renamed directories, ignored files and folders, symlinks, nested repositories, large and
  binary files, CRLF files under `.gitattributes`.
- Regatta or the computer stopping at any moment (quit, crash, power loss) and restarting.

**Out of scope** (documented as known limitations, not defended):
- Deliberately modifying anything in Regatta's own namespace while an operation runs: refs under
  `refs/heads/regatta/`, shadow repositories, data files, and the **temporary worktrees** Regatta makes
  for baselines and checks (they exist only during one operation and are never shown).
- `refs/replace` objects and symbolic refs aimed into Regatta's namespace (the engines still pass
  `--no-replace-objects` and `--no-deref` where git offers them, because it is cheap).
- Process id reuse inside a kill grace window.
- Edits made inside the copy of `node_modules` that Regatta provides in a worktree (a copy-on-write
  clone of the project's own, marked by Regatta). It is derived content Regatta made for that worktree;
  measurement and commits leave it out, and it moves to the trash with its worktree.
- Sub-second interleavings between one of Regatta's checks and the git or file operation that
  immediately follows it, where git itself offers no atomic form. Every such check is repeated
  right before the operation.

## The bar

No in-scope scenario may lose user work that git cannot give back. A work item is lost when it is
an uncommitted change that is overwritten or deleted, or a commit that is no longer reachable from
any ref or reflog. A leftover branch, a leftover worktree, a refused merge, a dangling HEAD that git
reports, or a step that cannot be rolled back are acceptable outcomes; the user is told what
happened. When an engine is unsure whether something is its own, it keeps it. Emptying Regatta's trash (2) deletes
what the user chose after being shown it; that is the user's own action, like emptying the Finder Trash.

## Shared mechanisms

1. **Merging into the user's branch** (`mergeIntoCurrentBranch` in `src/main/heats/git-ops.ts`,
   used by heats, hand-offs, night watch and flows):
   - Preconditions, rechecked right before writing: the project has a branch checked out (not
     detached), it is the branch and commit captured when the merge was requested, no merge,
     rebase, cherry-pick or revert is in progress, and tracked files have no uncommitted changes
     (an error checking any of these refuses).
   - When the branch is still at the tested commit's base: `git merge --ff-only
     --no-overwrite-ignore <tested sha>`.
   - Otherwise build the merge commit away from the user's folder: a temporary detached worktree at
     the captured HEAD, `git merge --no-ff --no-edit <tested sha>` there (a conflict refuses and
     removes the temporary worktree), then in the user's folder `git merge --ff-only
     --no-overwrite-ignore <merge commit>`.
   - The user's folder never sees a three-way merge, so Regatta never runs `git merge --abort`
     there. Git refuses a fast-forward that would overwrite an untracked or ignored file, including
     a file where a folder is needed and a case alias (verified on git 2.54, 2026-10-14).
   - Every git call made by these engines sets `GIT_NO_REPLACE_OBJECTS=1`.
   - The tracked-changes check (`dirtyTracked`) ignores submodules (8), so a staged or changed submodule pointer in
     the user's folder does not refuse the merge by itself. Git is the backstop: `git merge --ff-only` keeps a staged
     submodule pointer staged when the merge does not touch that submodule, and refuses ("Please commit your changes
     or stash them") when it would change it (checked on git 2.54, 2026-10-17).
2. **Retiring a lane worktree: moved to Regatta's trash, never deleted** (`trashOwnedWorktree` in
   `src/main/heats/git-ops.ts`, used by heats, hand-offs, night watch, flows and Storage). Regatta never
   deletes a folder the user or their programs could have touched. (Repeated review rounds each found a new way for "prove the worktree is untouched, then delete it" to be wrong: a writer
   that opened a file after the last scan, a filter that ran during the check, metadata the check did not
   read. A decision to destroy something based on inspecting it is a race against everyone who can change
   it; the only end to that race is not to destroy.) When an engine or Storage is done with a lane worktree:
   - **Ownership.** The folder must be strictly inside `worktreesDir` and still be the worktree Regatta made
     (`sameWorktree` with the identity recorded when git created it). Another folder there is left alone
     (`foreign`); an unknown identity keeps the folder where it is (`kept`).
   - **Commits are never asked about, they are kept.** `keepWorktreeHistory` makes one keep commit (Regatta's
     identity, hooks and signing off): an empty tree whose parents are the worktree's HEAD, the old and new id
     of every entry in every log the worktree owns (HEAD's and those of `refs/worktree/*`, `refs/bisect/*`,
     `refs/rewritten/*`), those per-worktree refs, and every object id in its pseudo refs (`ORIG_HEAD`, every
     `FETCH_HEAD` line, `MERGE_HEAD` and the other root-level capitals files of its git folder except `HEAD`
     and `index`), and the commit `rebase-merge/autostash` or `rebase-apply/autostash` names (a `rebase --autostash` in
     progress holds the user's uncommitted changes there), filtered with one `cat-file --batch-check` of `<id>^{commit}`
     (annotated tags peeled, trees and blobs dropped), chained past 500 parents, pointed at by `refs/regatta/discarded/<name>`. It reads refs
     and logs only, never the worktree's files. If it fails, the folder stays where it is, with the reason.
   - **The move.** Regatta checks with `lstat` that `<worktreesDir>/.regatta-trash` is a real folder (not a
     link) and creates it if missing, makes a new entry folder in it with an exclusive unique name
     (`mkdtemp`), writes `entry.json` there (original path, repository, branch, identity, keep ref, time),
     locks the worktree in git (`git worktree lock --reason "In Regatta's trash"`, sandboxed as in 8; a lock with that
     reason already there counts), then moves the worktree folder into the entry with one `rename(2)`. The lock means
     git's own `worktree prune` and `gc` never remove the worktree's git folder, whatever happens to the repair step
     below; if the rename fails, Regatta unlocks it again. `entry.json` is fsynced, and so are the entry, trash and
     worktrees folders before and after the rename, so a power loss leaves either the folder at its old path or a
     complete entry. On one volume a rename is atomic: at
     every instant the folder is whole at exactly one path. Its contents, permissions, extended attributes,
     ACLs, hard links and open files are untouched: a program writing through a file it has open keeps
     writing into the same file, now in the trash, and a program whose current folder is inside keeps
     working there. No git command reads or writes the folder's files during the move, so no hook, filter,
     lazy fetch or index refresh can run. If the rename fails for any reason (another volume, permissions, a
     busy mount), the folder stays where it is with the reason. There is no copy-and-delete fallback. A
     program that later opens a file by the old path gets an error, or makes a new folder at the old path,
     which Regatta treats as not its own and never touches.
   - **Git keeps knowing it.** Then `git worktree repair <new path>`, sandboxed as in 8, runs only when
     `<new path>/.git` is a file naming the worktree's own git folder (a relative `gitdir:` line is resolved against
     the folder holding the file, as git does; repositories may set `worktree.useRelativePaths`), so git keeps its index, HEAD and logs
     and its branch stays checked out there (git refuses to delete a branch checked out in a worktree). If
     repair is skipped or fails, `entry.json` says so and listing the trash tries again; the commits are
     already kept either way.
   - **The worktree's git folder is deleted only when Regatta knows everything in it** (a submodule initialised in a lane keeps its whole repository under `<git folder>/modules/`, and `rebase
     --autostash` keeps uncommitted work under `rebase-merge/`, so deleting the folder after keeping the lane's own
     commits still lost work). Empty trash deletes `<common dir>/worktrees/<id>` only when every entry in it is on a
     short known list (`KNOWN_GIT_FOLDER_FILES` in `git-ops.ts`): the regular files `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`,
     `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `BISECT_HEAD`, `AUTO_MERGE` (pseudo refs
     `keepWorktreeHistory` keeps), `COMMIT_EDITMSG` (the message of a commit already made), `index`, `commondir`,
     `gitdir`, `locked` and `config.worktree`; `logs/` holding only regular files and real folders; and `refs/`
     holding only `worktree/`, `bisect/` and `rewritten/`, each holding only regular files and real folders. A known
     name of another kind (a folder, a link), a link anywhere in those trees, and a folder that cannot be read count
     as unknown. Anything else leaves the git folder, its lock and the lane branch in place, and the entry's
     result names the folder and what is in it.
   - **A worktree the user re-attached is theirs.** Before repairing or emptying (and again right before deleting the
     worktree folder and the git folder), Regatta reads where the git folder's `gitdir` points now, resolved as git
     does. The git folder is the entry's own only when `gitdir` names a path inside the entry, or, for an entry
     Regatta never repaired (`repaired: false` in `entry.json`, or `entry.json` lost), `<originalPath>/.git` while
     nothing exists at the original path. Once Regatta has seen `gitdir` name the entry (`repaired: true`, set by a
     verified repair or when Empty trash writes a lost `entry.json` again from a `gitdir` naming the entry, and never
     cleared, since repair is retried only for entries that are not repaired),
     a `gitdir` naming `<originalPath>/.git` can only have been written by the user re-attaching a copy there, so it
     is the user's even while nothing is at the original path (2026-10-25 fix: a copy put back
     at the original path, repaired and then renamed away before Empty trash lost its git folder, index and branch).
     If `gitdir` names any other path, whether or not
     anything is there at that moment (a copy the user restored and repaired, at the original path or anywhere else,
     even one renamed away or on a volume that is not mounted just then), or if `<originalPath>/.git` is a regular
     file whose `gitdir:` line (relative to the original path, as git reads it) names the git folder (a copy put back
     without `git worktree repair`, which git works in all the same), the entry is "re-attached elsewhere, left
     alone": never repaired, never emptied, git records untouched. With `entry.json` lost, the original path is taken
     to be `<worktreesDir>/<name>`. A copy made somewhere else without a repair names nothing Regatta can see; see
     the known limitations. Known gap: for an entry Regatta never repaired, or one whose `entry.json` is lost, a copy
     the user re-attached at the original path and then moved away before Empty trash finishes still looks like the
     entry's own (git's records are the same as before Regatta's repair), so its git folder, index and branch can be
     lost; the lane's commits stay under the keep ref. The README lists this. (2026-10-17 fix round 1: the verifiers found a plain copy back, and a re-attached copy
     missing for a moment, lost their git folder.) When nothing exists at the path `gitdir` names, the listing and
     Empty trash say so and give the one command that gives the entry back to the trash, `git -C <repository>
     worktree repair <trash path>` (git's own `worktree prune` cannot: the trash lock keeps the record); Regatta never
     runs it by itself, because a copy on a volume that is not mounted just then looks the same.
     The exception is an entry Regatta never repaired whose `gitdir` still names `<originalPath>/.git` while nothing
     exists there. That counts as the entry's own, so listing the trash and Empty trash may run that repair
     themselves (the known gap above). An entry whose
     repository or git folder is gone (a Finder duplicate of an entry, after the original was emptied) is skipped with
     a note that git keeps nothing of it and that the user can delete the folder in Finder. (2026-10-17 fix round 2.)
   - **An entry is trusted only as far as its recorded identity proves it.** An entry folder must hold
     `entry.json` and exactly one real folder (`lstat`: not a link; its real parent is the entry) named
     `basename(originalPath)`, where that name is not empty, `.`, `..` or `entry.json`; `.DS_Store` is ignored, and
     anything else marks the entry "altered, left alone": never repaired, never emptied. The worktree's git folder
     and repository come from the identity recorded when git created it, never from asking git inside the folder,
     and the folder's `.git` file (relative paths resolved as git does) must name that git folder. Regatta never
     trashes, repairs or empties through a symlink. A worktree the user moved out of an entry is listed as moved
     out and left alone, git records included. With a lost `entry.json` the identity is read from the folder's
     `.git` file and its git folder's `commondir`, and only a branch under `regatta/` is deleted.
   - **Emptying the trash is the only deletion, and only a person does it**, from Settings > Storage. The
     list shows each entry's original path, branch, size and when it was moved. Entries a program is using
     (`lsof`) are skipped, and entries changed after they were moved (by modification time, outside the provided `node_modules` copy) are
     flagged. After one confirmation, for
     each entry, one at a time (a failure on one entry is reported and the next goes on): keep its commits again
     (new ones may have been made in the trash) under the entry's own keep ref; as the very last step before EACH deletion
     (the folder, the entry, and the git folder separately), with nothing in between, read the worktree's own logs, pseudo refs and `refs/worktree/*` again and
     skip the entry if they changed since the keep, and check with `lstat` and `realpath` that the entry folder (and
     the worktree folder in it) is still the real folder it was when emptying it began, never a link put in its
     place (nothing is written into the entry through a link either; known gap: a folder swapped for a link while the
     delete walk below is inside it is followed, see the README), and that no volume is mounted anywhere inside
     the folder; rename the folder to `<entry>/.regatta-deleting` (one `rename(2)` inside the entry) and delete it there,
     delete its git folder `<common dir>/worktrees/<id>` only when that folder's `gitdir` file, read before the
     deletion and resolved as git does (a relative path against that git folder), names `<the deleted folder>/.git` (or, for an entry Regatta never repaired, `<originalPath>/.git` while nothing exists there), then delete its branch through `deleteOwnedBranch` (3). Nothing empties the trash on a timer, by
     age or by size.
   - **Every delete stays on one volume** (2026-10-17 fix round 2: a disk image mounted inside a trashed lane moved
     with it, and Empty trash deleted the files on that volume; Node's recursive `rmSync` has no one-file-system mode).
     The worktree folder and the git folder are deleted by Regatta's own walk (`removeOnOneVolume`): `lstat` of each
     folder before it is entered, and a folder on another device than the entry (a disk image, sshfs, rclone, NFS or
     SMB mount) stops the delete before anything in it is touched; files and links go one at a time, a link is
     removed and never followed. Before the rename, a full walk looks for such a folder; the entry is then skipped
     with "a volume is mounted at <path> inside it; eject it first", nothing deleted and the `emptying` mark dropped,
     and the listing shows the entry as in use by that volume. The entry folder itself is deleted only when it holds
     nothing but `entry.json` (and `.DS_Store`): anything else that appeared there stays, with the entry.
   - **After a crash** at any step the folder is either at its old path (the next attempt moves it) or in the
     trash (the move happened). An entry folder with no worktree in it holds only Regatta's `entry.json` and
     is removed. An entry whose `entry.json` is missing or unreadable is still listed, with its repository and
     branch read from the worktree's own `.git` file, and can be emptied the same way. Empty trash writes two marks
     into `entry.json`: `emptying` before its first deletion, and `folderDeleted` once it deleted everything in the
     worktree folder, which it first renamed to `<entry>/.regatta-deleting`; only then is that empty folder removed.
     Only Regatta puts a folder at that name, so the rename is itself the mark that Regatta is deleting the folder: an
     entry holding `entry.json` with `emptying` and a `.regatta-deleting` folder (whole, partly deleted or empty), or
     only `entry.json` with both marks, whose git folder still points to it, is "unfinished; Empty trash finishes it"
     (2026-10-17 fix round 2: a crash between the end of the delete and the `folderDeleted` mark used to leave an
     entry listed as moved out for good). When the delete fails, what is left is renamed back to its own name. With
     `emptying` alone and only `entry.json` (the delete failed, for example on a folder locked in Finder, and the user
     then moved the worktree out) it is "moved out" and left alone, git records included; an entry an older build
     marked with `emptying` alone lists the same way (its git folder and branch stay, which is a leftover, never a
     loss). A `.regatta-deleting` folder without the `emptying` mark is "altered, left alone". A user who takes a
     `.regatta-deleting` folder out of an entry after a crash leaves `entry.json` with `emptying` alone: the entry is
     then "moved out", its git records left alone. A crash in the instant between deleting the entry folder and deleting the git
     folder leaves that git folder locked, with its branch, and no entry that names it: nothing is lost, and
     `git worktree list` shows it (remove it with `git worktree unlock` and `git worktree prune`).
   - **Temporary worktrees** (baselines, the worktree checks run in, the one a merge is built in; out of scope
     above) are still removed with `git worktree remove --force` once their identity is confirmed.
   - Checks never run in a lane worktree: they run in a temporary worktree at the lane's committed tip.
   - **Project subfolder containment.** Status 2026-10-27: built for heats only (`SYMLINK_REFUSAL` in
     `src/main/heats/engine.ts`). The shared helper below (`src/main/heats/containment.ts`, used by heats, hand-offs,
     night watch and flows) is on branch `pkg/containment`, not merged, so night watch and flows do not check this
     yet (the README lists it). The design: when a project is opened as a subfolder of its repository (the prefix),
     before every setup, agent step and check Regatta inspects each existing ancestor of the prefix inside THE
     FOLDER THAT STEP RUNS IN (the lane worktree for agents and setup, the temporary check worktree for checks,
     where a committed symlink is checked out again) before creating any missing folders, and verifies that
     `realpathSync` of every ancestor and of the working folder itself is strictly inside `realpathSync` of that
     worktree. If any segment is a symlink leading outside it (or a dangling link), the step is refused before any
     folder is created or anything runs, with `"Refused: the project folder inside the worktree leads outside it
     (a symlink)."`
3. **Deleting an engine's branch** (`deleteOwnedBranch`). A lane branch stays while its worktree is in the
   trash (it is checked out there) and is deleted when that trash entry is emptied. It is deleted only when the branch is not checked out
   anywhere and points exactly at the commit the engine recorded (the tested commit, or the start
   commit for a lane that never committed): `git update-ref --no-deref -d refs/heads/<name>
   <expected sha>`. Every git command during preservation and branch deletion (`rev-parse`, `symbolic-ref`,
   `cat-file`, `hash-object`, `commit-tree`, and `update-ref` for both the keep ref and the branch delete)
   runs with `-c core.hooksPath=<an empty folder Regatta owns>` (refusing if that folder is not empty), so
   user hooks (`reference-transaction` and all others) never run during preservation or removal. A branch
   that moved is kept. Deleting a branch drops its reflog, so before it goes
   everything it could be the last holder of is kept with `keepCommits`: one commit with an empty tree
   (Regatta's identity, hooks and signing off) whose parents are the tip and the old and new id of every
   reflog entry (the old id matters: after a partial expiry it can be the only trace of a commit),
   deduplicated, annotated tags peeled to their commit, anything else that is not a commit dropped, chained through several keep commits past 500
   parents (every keep commit has the tip, or the worktree's HEAD, as its first parent, so `<ref>^1` is
   always the work). The reflog is read before and after keeping; if it grew in between, the branch is
   kept and looked at again. It is pointed at by `refs/regatta/discarded/<name>` (the branch name without the leading
   `regatta/`, or a name the caller gives; `-2`, `-3` when taken; created only if the name is free).
   Only after that ref exists is the branch deleted; if any step fails everything is kept. No question
   is asked about branches, tags or stashes that might also hold the commits. The caller tells the user
   where the copy is: `git branch <name> refs/regatta/discarded/<name>^1` restores the tip, `git log
   refs/regatta/discarded/<name>` lists everything kept.
4. **Process lifetime** (`supervise` in `procgroup.ts`): agents and checks run in their own process
   group; stopping sends SIGTERM to the group, then SIGKILL after a grace period; the result says
   whether every process is gone (`stopped`) or not (`stuck`). A group seen absent is never signaled
   again. On `stuck`, nothing that process could be using is removed. The Git panel's own git runner
   (`run` in `gitview.ts`) answers the same way, and every caller of it surfaces `stuck` to the user
   before looking at truncation or at the exit code: git that was stopped but left a live group is
   never reported as a clean answer or as output that was merely too large.
5. **Repository identity** for locks is the canonical git common folder; failing to read it refuses
   the operation.
6. **Git's environment** (`withoutRepoRouting` in `src/main/env.ts`): every git call the app makes
   (`git-ops.ts`, `storage.ts`, `gitview.ts`, `git.ts`, `relay-service.ts`, `search.ts`) starts from
   the app's environment minus the variables
   that aim git at another repository, folder, index or object store: the list printed by `git rev-parse
   --local-env-vars` on git 2.54 (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
   `GIT_OBJECT_DIRECTORY`, `GIT_PREFIX`, `GIT_CONFIG_COUNT` and the rest), plus `GIT_NAMESPACE`,
   `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_EXEC_PATH`, `GIT_QUARANTINE_PATH` and every
   `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`. An inherited `GIT_WORK_TREE` would make every status and
   check look at the project while the removal acts on the lane, so ignored notes in the lane would not
   count. `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_SYSTEM` are kept (they pick config files,
   and tests rely on them). The shadow repository of checkpoints removes them too before setting its own
   `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`; `cleanEnv`, which builds the environment agents and
   checks run in, never carries them; and `stripRepoRoutingFromProcess` removes them from the app's own
   environment at startup.
7. **A failed Git panel refresh says so** (`src/renderer/src/panels/GitPanel.tsx`): when a refresh
   fails while an older status is on screen, the error is shown above that retained data with the time
   it was read, until a refresh succeeds. Quietly keeping the last good answer would let the commit box
   act on files the repository no longer has.
8. **Regatta's own automatic git calls run sandboxed** (`sandboxGitArgs` and the runner in `git-ops.ts`, and
   Storage's metadata reads in `storage.ts`): preservation (`keepWorktreeHistory`, `keepCommits`), branch
   deletion, `commitAll`, measurement (`diffFrom`, `diffBetween` and the live diff samplers), `git worktree
   repair`, and emptying the trash. Each runs with `-c core.hooksPath=<an empty folder Regatta owns>`
   (refusing if that folder is not empty), `-c core.fsmonitor=false -c maintenance.auto=false -c gc.auto=0
   -c commit.gpgsign=false -c tag.gpgSign=false`, `-c core.trustctime=true -c core.checkStat=default -c
   core.ignoreStat=false`, `--no-ext-diff --no-textconv` on `git diff`, and for every configured filter driver
   (`^filter\..*\.(clean|smudge|process)$`) and config hook (`^hook\..*\.(command|event)$`), `-c
   filter.<d>.clean= -c filter.<d>.smudge= -c filter.<d>.process= -c filter.<d>.required=false` and `-c
   hook.<h>.enabled=false -c hook.<h>.command= -c hook.<h>.event=`. Every one also runs with
   `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=` (empty: no transport), so a partial clone never contacts
   its remote, and a missing object is an error that is shown. Finding the filter drivers and config hooks reads
   `git config -z --get-regexp` (records split on NUL, the key is what comes before the first newline, so a value
   can never be mistaken for part of a name) and refuses any driver or hook whose name contains `=`, a newline or
   NUL, since `-c` cannot override it. It fails closed: only git's documented "no match" answer means there are none; a timeout, output over the
   limit, a failure to start git or any other error refuses the operation with the reason, and no further
   git command runs for it. A measurement that fails keeps the last good result and shows the error on the
   lane; git's expected "needs update" answer from a refresh is not a failure. In a repository whose tracked
   files use a non-empty `clean` or `process` filter (such as Git LFS), `commitAll` refuses with the reason
   instead of committing content the filter would have changed. `commitAll`, `gitStatus`, `hasChanges` and
   `dirtyTracked` never enter a submodule or nested repository (`-c submodule.recurse=false -c
   diff.ignoreSubmodules=all`, `--ignore-submodules=all`, and every gitlink left out of `git add -A` with the exclude
   pathspecs `diffFrom` builds): their own config is not Regatta's to run. The trade-off, accepted: a lane whose only
   change is a new commit inside a submodule (or a nested repository) commits nothing for it, and `commitAll` answers
   "no changes"; the submodule's commit stays in its own repository (for a lane, under the kept git folder's
   `modules/`, which Empty trash keeps), and a gitlink the user staged themselves stays staged, uncommitted.

## Known limitations (ship in the README)

Kept short and honest: the out-of-scope list above, plus whatever the last review rounds leave open. Regatta's trash grows until you empty it
in Settings > Storage: lane worktrees are never deleted automatically. A worktree that cannot be moved
into the trash (for example one on another volume) stays where it is, with the reason. Emptying deletes each
trashed folder with everything in it, including a repository nested inside it (the Storage confirmation says so),
but never enters a volume mounted inside it (the entry is skipped until it is ejected); the lane's own commits stay
kept. A commit written into a worktree's git folder in the microseconds between Empty trash's last check of that
folder and its delete is lost (the sub-second carve-out above); a commit any earlier keeps the folder. A copy of a trashed worktree made somewhere other than its original path (or put there and then moved away) without
`git worktree repair` still uses the trashed worktree's git folder, which Regatta cannot see: Empty trash deletes
that git folder, and git then stops working in the copy: its files stay, and so do its commits (under the keep
ref), but what was only staged there and its branch checkout go with the git folder.
