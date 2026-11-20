//! Opener precedence.

use theorem_workbench_core::panel::OpenTarget;
use theorem_workbench_core::{OPENER_SPECIFIC, PanelFactories};

fn file(path: &str) -> OpenTarget {
    OpenTarget::File {
        workspace: "w".into(),
        path: path.into(),
    }
}

fn markdown(t: &OpenTarget) -> bool {
    matches!(t, OpenTarget::File { path, .. }
        if [".md", ".markdown", ".mdx"].iter().any(|e| path.ends_with(e)))
}

fn any_file(t: &OpenTarget) -> bool {
    matches!(t, OpenTarget::File { .. })
}

fn kind_of(f: &PanelFactories, path: &str) -> String {
    f.opener_of(&file(path))
        .expect("some kind")
        .as_str()
        .to_owned()
}

#[test]
fn a_specific_opener_wins_whichever_registered_first() {
    for markdown_first in [true, false] {
        let mut f = PanelFactories::new();
        if markdown_first {
            f.register_opener_with("markdown", OPENER_SPECIFIC, markdown);
            f.register_opener("editor", any_file);
        } else {
            f.register_opener("editor", any_file);
            f.register_opener_with("markdown", OPENER_SPECIFIC, markdown);
        }
        for path in ["a.md", "b.markdown", "c.mdx"] {
            assert_eq!(kind_of(&f, path), "markdown", "{path} {markdown_first}");
        }
        assert_eq!(kind_of(&f, "a.rs"), "editor", "{markdown_first}");
    }
}

#[test]
fn equal_priorities_keep_registration_order() {
    let mut f = PanelFactories::new();
    f.register_opener("first", any_file);
    f.register_opener("second", any_file);
    assert_eq!(kind_of(&f, "a.rs"), "first");
    // Registering a kind again replaces it and puts it last.
    f.register_opener("first", any_file);
    assert_eq!(kind_of(&f, "a.rs"), "second");
}
