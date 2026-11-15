//! The change list's data: five groups, status letters, how a path is shown, what a
//! discard costs, how much of a long section is listed.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! (MIT, see `LICENSE-ELY`):
//! - `src/git/panel/view.rs` (blob 9e1cfe63f7490d521efe1ddf1675c6a738a624e7): `shown`,
//!   `is_folder`, `loss`, `cut` and `LISTED`, `head`;
//! - `src/git.rs` (blob d5d2a4346ae9ef4ec097eab1daaadc2d8dc24068): the sort of a status
//!   record into conflicted, staged, unstaged and untracked (`repo`);
//! - `src/git/panel.rs` (blob 26133bcffa1a2de18dcb50d169fb55b959be0369): `listed`.
//!
//! Translated from ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! (MIT): `src/git/changes.rs` (blob 9591530a7aadc9f88b726afd97d81a1079ecc795), the
//! `ChangeSection` order and which actions a section offers.
//!
//! Changed: the donor reads porcelain v2 records itself; here the SCM owner has already
//! read git, so the groups are made from the wire's `ScmChange` rows by the rule the
//! owner's own grouping uses (`src/lib/workbench/scm/scm.ts` `statusOfAnswer`). A row the
//! host sent without its two status letters is kept in its own group and never guessed
//! into another. A path is a string, so the donor's non-UTF-8 octal escapes are not needed.

use serde::{Deserialize, Serialize};
use theorem_workbench_core::completion::{BranchState, RepoState, ScmChange, ScmStatus};
use theorem_workbench_text::visible::hidden;

/// The most files a section lists. The donor draws every row each frame and so caps it.
pub const LISTED: usize = 500;

/// The part of the work tree a file is listed in, in the order the donor lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Conflicted,
    Staged,
    Unstaged,
    Untracked,
    /// Rows the host sent without their status letters.
    Unclassified,
}

impl Section {
    pub const ALL: [Section; 5] = [
        Section::Conflicted,
        Section::Staged,
        Section::Unstaged,
        Section::Untracked,
        Section::Unclassified,
    ];

    /// The heading text (`git.changes.*` in the donor).
    pub fn title(self) -> &'static str {
        match self {
            Self::Conflicted => "Conflicted",
            Self::Staged => "Staged",
            Self::Unstaged => "Unstaged",
            Self::Untracked => "Untracked",
            Self::Unclassified => "Status not reported",
        }
    }

    /// What a diff opened from this section compares, for its heading.
    pub fn compares(self) -> &'static str {
        match self {
            Self::Conflicted => "conflicted file, working tree against the index",
            Self::Staged => "index against HEAD",
            Self::Unstaged => "working tree against the index",
            Self::Untracked => "new file against nothing",
            Self::Unclassified => "no comparison: status not reported",
        }
    }

    /// Whether the donor's list offers stage on a row of this section.
    pub fn can_stage(self) -> bool {
        matches!(self, Self::Unstaged | Self::Untracked)
    }

    pub fn can_unstage(self) -> bool {
        self == Self::Staged
    }

    /// Discard is offered on unstaged and untracked rows only (donor `changes.rs`).
    pub fn can_discard(self) -> bool {
        matches!(self, Self::Unstaged | Self::Untracked)
    }

    /// Whether a diff can be asked for. A row with no status has nothing to compare.
    pub fn can_diff(self) -> bool {
        self != Self::Unclassified
    }

    /// The `staged` flag of the owner's diff: the index against HEAD, or the working
    /// tree against the index. The donor diffs a conflicted file against HEAD; the owner
    /// has no such diff, so it is asked for the working tree.
    pub fn diff_staged(self) -> bool {
        self == Self::Staged
    }
}

/// One file's row: a section and a path. A path changed on both sides has a row in
/// `Staged` and another in `Unstaged`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowKey {
    pub section: Section,
    pub path: String,
}

impl RowKey {
    pub fn new(section: Section, path: impl Into<String>) -> Self {
        Self {
            section,
            path: path.into(),
        }
    }
}

/// A changed file as the host reported it.
pub type Change = ScmChange;

/// The work tree's changes in the donor's groups, each in the order the owner sent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Groups {
    pub conflicted: Vec<Change>,
    pub staged: Vec<Change>,
    pub unstaged: Vec<Change>,
    pub untracked: Vec<Change>,
    pub unclassified: Vec<Change>,
}

impl Groups {
    /// The rule of `scm.ts` `statusOfAnswer`, row by row, in the order given: a row
    /// without both letters is unclassified; a conflict is conflicted; `??` is
    /// untracked; otherwise a letter other than space and `?` on the index side puts the
    /// row in staged and on the worktree side in unstaged, both when both apply.
    pub fn classify(changes: &[Change]) -> Self {
        let mut groups = Self::default();
        for change in changes {
            if change.index.is_empty() || change.worktree.is_empty() {
                groups.unclassified.push(change.clone());
            } else if change.conflict {
                groups.conflicted.push(change.clone());
            } else if change.index == "?" && change.worktree == "?" {
                groups.untracked.push(change.clone());
            } else {
                if change.index != " " && change.index != "?" {
                    groups.staged.push(change.clone());
                }
                if change.worktree != " " && change.worktree != "?" {
                    groups.unstaged.push(change.clone());
                }
            }
        }
        groups
    }

    pub fn section(&self, section: Section) -> &[Change] {
        match section {
            Section::Conflicted => &self.conflicted,
            Section::Staged => &self.staged,
            Section::Unstaged => &self.unstaged,
            Section::Untracked => &self.untracked,
            Section::Unclassified => &self.unclassified,
        }
    }

    pub fn find(&self, key: &RowKey) -> Option<&Change> {
        self.section(key.section)
            .iter()
            .find(|change| change.path == key.path)
    }

    pub fn total(&self) -> usize {
        Section::ALL.iter().map(|s| self.section(*s).len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }

    /// Listed and total changes, when a section's list leaves some out (donor `cut`).
    pub fn cut(&self) -> Option<(usize, usize)> {
        let total = self.total();
        let listed: usize = Section::ALL
            .iter()
            .map(|s| self.section(*s).len().min(LISTED))
            .sum();
        (listed < total).then_some((listed, total))
    }

    /// Every row that is listed, in list order.
    pub fn keys(&self) -> impl Iterator<Item = RowKey> + '_ {
        Section::ALL.into_iter().flat_map(move |section| {
            self.section(section)
                .iter()
                .take(LISTED)
                .map(move |change| RowKey::new(section, change.path.clone()))
        })
    }
}

/// The letter a row shows (the badge). Staged rows show the index letter, unstaged the
/// worktree letter; untracked `U` and conflicted `!` as the Theia view had them; a row
/// with no status shows `?`.
pub fn letter(section: Section, change: &Change) -> char {
    let first = |side: &str| side.chars().next().filter(|c| *c != ' ').unwrap_or('?');
    match section {
        Section::Conflicted => '!',
        Section::Staged => first(&change.index),
        Section::Unstaged => first(&change.worktree),
        Section::Untracked => 'U',
        Section::Unclassified => '?',
    }
}

/// `path` as the panel shows it: on one line, one string to a path. As it is, or quoted
/// as git quotes a name with control characters, quotes or backslashes. A folder's
/// trailing slash is dropped (donor `shown`).
pub fn shown(path: &str) -> String {
    let path = path.strip_suffix('/').unwrap_or(path);
    let plain = |c: char| !c.is_control() && !hidden(c) && c != '"' && c != '\\';
    if path.chars().all(plain) {
        return path.to_owned();
    }
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() || hidden(c) => {
                let mut bytes = [0; 4];
                for byte in c.encode_utf8(&mut bytes).bytes() {
                    out.push_str(&format!("\\{byte:03o}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Git ends a folder with a slash, and no file shares a folder's name.
pub fn is_folder(path: &str) -> bool {
    path.ends_with('/')
}

/// What discarding a change costs, in the donor's three words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loss {
    Folder,
    File,
    Changes,
}

impl Loss {
    pub fn text(self) -> &'static str {
        match self {
            Self::Folder => "Its untracked files are deleted.",
            Self::File => "It is deleted.",
            Self::Changes => "Its unstaged changes are lost.",
        }
    }
}

/// Donor `loss`: an untracked folder takes its files, an untracked or only-intended file
/// is deleted, any other edit is lost. The donor's "intended to be added" and "renamed"
/// are the worktree letters `A` and `R`.
pub fn loss(section: Section, change: &Change) -> Loss {
    let new_file = matches!(change.worktree.as_str(), "A" | "R");
    match section {
        Section::Untracked if is_folder(&change.path) => Loss::Folder,
        Section::Untracked => Loss::File,
        _ if new_file => Loss::File,
        _ => Loss::Changes,
    }
}

/// What the branch line says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Head {
    /// A branch is checked out.
    Branch(String),
    /// HEAD is detached; the short commit when the host gave one.
    Detached(Option<String>),
    /// The host reported neither a branch nor a detached head.
    NotReported,
}

impl Head {
    /// From a status answer: the state's branch tells a detached head from one the host
    /// did not report; the status's own branch name is the fallback for an answer that
    /// carries no state.
    pub fn of(status: &ScmStatus) -> Self {
        let state_branch = status.state.as_ref().map(|s| &s.branch);
        let short = status
            .head
            .as_ref()
            .or(status.state.as_ref().and_then(|s| s.head.as_ref()))
            .map(|head| head.chars().take(7).collect());
        match (state_branch, &status.branch) {
            (Some(BranchState::Named(name)), _) => Self::Branch(name.clone()),
            (Some(BranchState::Detached), _) => Self::Detached(short),
            (Some(BranchState::Unreported) | None, Some(name)) => Self::Branch(name.clone()),
            (Some(BranchState::Unreported) | None, None) => Self::NotReported,
        }
    }

    /// Donor `head`: a branch, or a detached head's short commit.
    pub fn label(&self) -> String {
        match self {
            Self::Branch(name) => name.clone(),
            Self::Detached(Some(short)) => format!("({short} detached)"),
            Self::Detached(None) => "(detached)".to_owned(),
            Self::NotReported => "branch not reported".to_owned(),
        }
    }
}

/// What makes an open diff out of date: the repository state it was read at and the
/// row's own letters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Basis {
    pub state: Option<RepoState>,
    pub head: Option<String>,
    pub change: Change,
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn row(path: &str, index: &str, worktree: &str) -> Change {
        Change {
            path: path.into(),
            index: index.into(),
            worktree: worktree.into(),
            original_path: None,
            conflict: false,
        }
    }

    #[test]
    fn a_shown_path_is_one_line_and_one_to_a_path() {
        assert_eq!(shown("src/main.rs"), "src/main.rs");
        assert_eq!(
            shown("notes/"),
            "notes",
            "the list names a folder by its name"
        );
        assert_eq!(shown("café/ü.txt"), "café/ü.txt");
        assert_eq!(shown("line\nbreak"), "\"line\\nbreak\"");
        assert_eq!(shown("a\"b\\c\td"), "\"a\\\"b\\\\c\\td\"");
        assert_eq!(shown("bell\u{7}"), "\"bell\\007\"");
        assert_ne!(
            shown("\"line\\nbreak\""),
            shown("line\nbreak"),
            "a name that spells a quoting reads apart from the name quoted"
        );
    }

    #[test]
    fn a_discard_says_what_it_costs() {
        let untracked = Section::Untracked;
        assert_eq!(
            loss(untracked, &row("notes/", "?", "?")).text(),
            "Its untracked files are deleted."
        );
        assert_eq!(
            loss(untracked, &row("a.txt", "?", "?")).text(),
            "It is deleted."
        );
        let intended = row("a.txt", " ", "A");
        assert_eq!(loss(Section::Unstaged, &intended).text(), "It is deleted.");
        let edited = row("a.txt", " ", "M");
        assert_eq!(
            loss(Section::Unstaged, &edited).text(),
            "Its unstaged changes are lost."
        );
    }

    #[test]
    fn a_long_section_lists_its_first_files_and_says_so() {
        let many = |count: usize| -> Vec<Change> {
            (0..count)
                .map(|n| row(&format!("f{n}.txt"), " ", "M"))
                .collect()
        };
        let mut groups = Groups {
            staged: many(2),
            unstaged: many(LISTED),
            ..Groups::default()
        };
        assert_eq!(groups.cut(), None);
        groups.unstaged = many(LISTED + 100);
        assert_eq!(
            groups
                .keys()
                .filter(|k| k.section == Section::Unstaged)
                .count(),
            LISTED
        );
        assert_eq!(groups.cut(), Some((LISTED + 2, LISTED + 102)));
    }

    #[test]
    fn head_reads_as_its_branch_or_its_commit() {
        let status = |branch: Option<&str>, state: BranchState| ScmStatus {
            branch: branch.map(Into::into),
            head: Some("1a2b3c4d5e6f".into()),
            changes: vec![],
            state: Some(RepoState {
                branch: state,
                ..RepoState::default()
            }),
        };
        let named = status(Some("main"), BranchState::Named("main".into()));
        assert_eq!(Head::of(&named), Head::Branch("main".into()));
        assert_eq!(Head::of(&named).label(), "main");
        let detached = status(None, BranchState::Detached);
        assert_eq!(Head::of(&detached), Head::Detached(Some("1a2b3c4".into())));
        assert_eq!(Head::of(&detached).label(), "(1a2b3c4 detached)");
        let silent = status(None, BranchState::Unreported);
        assert_eq!(Head::of(&silent), Head::NotReported);
        assert_eq!(Head::of(&silent).label(), "branch not reported");
    }

    #[test]
    fn classification_follows_the_owner_and_never_guesses() {
        let mut conflict = row("c.rs", "U", "U");
        conflict.conflict = true;
        let changes = vec![
            row("both.rs", "M", "M"),
            row("new.rs", "?", "?"),
            conflict,
            row("lost.rs", "", ""),
            row("half.rs", "M", ""),
            row("idx.rs", "A", " "),
            row("wt.rs", " ", "D"),
        ];
        let groups = Groups::classify(&changes);
        fn names(s: &[Change]) -> Vec<&str> {
            s.iter().map(|c| c.path.as_str()).collect()
        }
        assert_eq!(names(&groups.staged), ["both.rs", "idx.rs"]);
        assert_eq!(names(&groups.unstaged), ["both.rs", "wt.rs"]);
        assert_eq!(names(&groups.untracked), ["new.rs"]);
        assert_eq!(names(&groups.conflicted), ["c.rs"]);
        assert_eq!(names(&groups.unclassified), ["lost.rs", "half.rs"]);
        assert_eq!(letter(Section::Staged, &changes[0]), 'M');
        assert_eq!(letter(Section::Unstaged, &changes[6]), 'D');
        assert_eq!(letter(Section::Unclassified, &changes[3]), '?');
    }
}
