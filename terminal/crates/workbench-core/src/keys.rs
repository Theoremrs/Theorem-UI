//! One table from key chords to action ids (R05, spec 5). Defaults come from
//! the registry's descriptors; a user's overrides sit on top and sync with the
//! account. Chord parsing and printing is the `keybinds` crate's; this module
//! adds contexts, layering, conflict detection and the text-entry rule.

use std::str::FromStr;

use keybinds::{Key, KeyInput, Mods};
use serde::{Deserialize, Serialize};

use crate::ids::{ActionId, PanelKind};
use crate::registry::Registry;

/// Where a binding applies. The caller says which contexts are active, most
/// specific first; see [`active_contexts`].
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KeyContext {
    Global,
    /// While a panel of this kind has focus.
    Panel {
        kind: PanelKind,
    },
    /// While a text surface (composer, editor) has focus.
    TextEntry,
}

/// The contexts live for the current focus, most specific first. While text is
/// being entered only text-entry and global bindings are consulted, so a
/// panel's single-key commands never take typing.
pub fn active_contexts(panel: Option<&PanelKind>, text_entry: bool) -> Vec<KeyContext> {
    let mut out = Vec::with_capacity(2);
    if text_entry {
        out.push(KeyContext::TextEntry);
    } else if let Some(kind) = panel {
        out.push(KeyContext::Panel { kind: kind.clone() });
    }
    out.push(KeyContext::Global);
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Mac,
    Other,
}

/// One binding, as stored and synced. The chord is text such as
/// `Mod+Shift+G`; `Mod` becomes Cmd on Mac and Ctrl elsewhere at parse time,
/// because the browser's platform is known only at run time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub chord: String,
    pub context: KeyContext,
    pub action: ActionId,
}

/// Removes a default binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Unbind {
    pub chord: String,
    pub context: KeyContext,
}

pub const OVERRIDES_VERSION: u32 = 1;

/// What a person changed from the defaults: the part that syncs to the
/// account. Defaults are not stored, so a new release's defaults still arrive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    pub version: u32,
    #[serde(default)]
    pub bind: Vec<Shortcut>,
    #[serde(default)]
    pub unbind: Vec<Unbind>,
}

impl Default for Overrides {
    fn default() -> Self {
        Self {
            version: OVERRIDES_VERSION,
            bind: vec![],
            unbind: vec![],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IssueKind {
    /// The chord text does not parse, or is a multi-key sequence (not supported).
    InvalidChord { error: String },
    /// Another binding already holds this chord in this context. The first one
    /// stays; this one is not active.
    Conflict { held_by: ActionId },
    /// A bare printable key in a context where the person is typing.
    BareKey,
    /// The registry has no such action (a saved binding for a removed panel).
    UnknownAction,
    /// An override file from a newer build.
    UnsupportedVersion { version: u32 },
}

/// A binding the table did not accept. Reported, never silently dropped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeyIssue {
    pub chord: String,
    pub context: KeyContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub action: Option<ActionId>,
    pub kind: IssueKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Default,
    User,
}

#[derive(Clone, Debug)]
struct Entry {
    input: KeyInput,
    context: KeyContext,
    action: ActionId,
    source: Source,
}

#[derive(Clone, Debug)]
pub struct KeyTable {
    platform: Platform,
    entries: Vec<Entry>,
}

/// Parse a chord. `Mod` is expanded for the platform first; everything else is
/// the `keybinds` syntax. One chord only: sequences are refused.
pub fn parse_chord(text: &str, platform: Platform) -> Result<KeyInput, String> {
    let mut parts: Vec<&str> = text.trim().split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let mods = parts
        .into_iter()
        .map(|m| match (m.eq_ignore_ascii_case("mod"), platform) {
            (true, Platform::Mac) => "Cmd",
            (true, Platform::Other) => "Ctrl",
            (false, _) => m,
        })
        .collect::<Vec<_>>();
    // `keybinds` reads a capital letter as the logical key Shift produced, so
    // "Mod+Alt+T" would never match the `t` a browser reports for Ctrl+Alt+T.
    // A letter is the unshifted key unless the chord names Shift.
    let shifted = mods.iter().any(|m| m.eq_ignore_ascii_case("shift"));
    let key = match key.chars().collect::<Vec<_>>().as_slice() {
        [c] if c.is_ascii_alphabetic() && shifted => c.to_ascii_uppercase().to_string(),
        [c] if c.is_ascii_alphabetic() => c.to_ascii_lowercase().to_string(),
        _ => key.to_owned(),
    };
    let expanded = mods
        .iter()
        .copied()
        .chain(std::iter::once(key.as_str()))
        .collect::<Vec<_>>()
        .join("+");
    KeyInput::from_str(&expanded).map_err(|e| e.to_string())
}

/// A chord as a person reads it: glyphs on Mac, words elsewhere.
pub fn format_chord(input: &KeyInput, platform: Platform) -> String {
    let mods = input.mods();
    let key = match input.key() {
        Key::Char(c) => c.to_uppercase().collect::<String>(),
        other => other.to_string(),
    };
    match platform {
        Platform::Mac => {
            let mut out = String::new();
            for (flag, glyph) in [
                (Mods::CTRL, '⌃'),
                (Mods::ALT, '⌥'),
                (Mods::SHIFT, '⇧'),
                (Mods::CMD, '⌘'),
            ] {
                if mods.contains(flag) {
                    out.push(glyph);
                }
            }
            out + &key
        }
        Platform::Other => {
            let mut out = String::new();
            for (flag, word) in [
                (Mods::CTRL, "Ctrl+"),
                (Mods::ALT, "Alt+"),
                (Mods::SHIFT, "Shift+"),
                (Mods::CMD, "Cmd+"),
                (Mods::WIN, "Win+"),
            ] {
                if mods.contains(flag) {
                    out.push_str(word);
                }
            }
            out + &key
        }
    }
}

/// A key that types a character, with nothing but Shift held.
fn is_bare_printable(input: &KeyInput) -> bool {
    matches!(input.key(), Key::Char(_)) && input.mods().difference(Mods::SHIFT).is_empty()
}

fn allowed_in(context: &KeyContext, input: &KeyInput) -> bool {
    match context {
        KeyContext::Panel { .. } => true,
        KeyContext::Global | KeyContext::TextEntry => !is_bare_printable(input),
    }
}

impl KeyTable {
    /// The registry's defaults with `overrides` layered on top. Whatever cannot
    /// be accepted comes back as an issue.
    pub fn build(
        registry: &Registry,
        platform: Platform,
        overrides: &Overrides,
    ) -> (Self, Vec<KeyIssue>) {
        let mut table = Self {
            platform,
            entries: vec![],
        };
        let mut issues = vec![];

        for shortcut in registry.default_shortcuts() {
            table.add(shortcut, Source::Default, registry, &mut issues);
        }

        if overrides.version > OVERRIDES_VERSION {
            issues.push(KeyIssue {
                chord: String::new(),
                context: KeyContext::Global,
                action: None,
                kind: IssueKind::UnsupportedVersion {
                    version: overrides.version,
                },
            });
            return (table, issues);
        }

        for unbind in &overrides.unbind {
            if let Ok(input) = parse_chord(&unbind.chord, platform) {
                table.entries.retain(|e| {
                    !(e.source == Source::Default
                        && e.context == unbind.context
                        && e.input == input)
                });
            }
        }
        for shortcut in &overrides.bind {
            table.add(shortcut.clone(), Source::User, registry, &mut issues);
        }
        (table, issues)
    }

    fn add(
        &mut self,
        shortcut: Shortcut,
        source: Source,
        registry: &Registry,
        issues: &mut Vec<KeyIssue>,
    ) {
        let mut refuse = |kind: IssueKind| {
            issues.push(KeyIssue {
                chord: shortcut.chord.clone(),
                context: shortcut.context.clone(),
                action: Some(shortcut.action.clone()),
                kind,
            });
        };
        let input = match parse_chord(&shortcut.chord, self.platform) {
            Ok(input) => input,
            Err(error) => return refuse(IssueKind::InvalidChord { error }),
        };
        if registry.action(&shortcut.action).is_none() {
            return refuse(IssueKind::UnknownAction);
        }
        if !allowed_in(&shortcut.context, &input) {
            return refuse(IssueKind::BareKey);
        }
        if let Some(pos) = self
            .entries
            .iter()
            .position(|e| e.context == shortcut.context && e.input == input)
        {
            // A person's binding replaces a default on the same chord. Two of the
            // same layer cannot both hold it.
            if self.entries[pos].source == Source::Default && source == Source::User {
                self.entries.remove(pos);
            } else {
                let held_by = self.entries[pos].action.clone();
                if held_by != shortcut.action {
                    return refuse(IssueKind::Conflict { held_by });
                }
                return;
            }
        }
        self.entries.push(Entry {
            input,
            context: shortcut.context,
            action: shortcut.action,
            source,
        });
    }

    /// The action a key press means, trying `active` contexts in order.
    pub fn resolve(&self, input: &KeyInput, active: &[KeyContext]) -> Option<&ActionId> {
        active.iter().find_map(|context| {
            self.entries
                .iter()
                .find(|e| &e.context == context && &e.input == input)
                .map(|e| &e.action)
        })
    }

    /// The chord to show for an action: a person's own binding first.
    pub fn label(&self, action: &ActionId) -> Option<String> {
        let mut mine = self.entries.iter().filter(|e| &e.action == action);
        let first = mine
            .clone()
            .find(|e| e.source == Source::User)
            .or_else(|| mine.next())?;
        Some(format_chord(&first.input, self.platform))
    }

    /// Who already holds `candidate`'s chord in its context, for a settings
    /// screen to warn before saving. Empty means it is free.
    pub fn held_by(&self, candidate: &Shortcut) -> Vec<ActionId> {
        let Ok(input) = parse_chord(&candidate.chord, self.platform) else {
            return vec![];
        };
        self.entries
            .iter()
            .filter(|e| {
                e.context == candidate.context && e.input == input && e.action != candidate.action
            })
            .map(|e| e.action.clone())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::registry;

    fn press(text: &str, platform: Platform) -> KeyInput {
        parse_chord(text, platform).unwrap()
    }

    fn shortcut(chord: &str, context: KeyContext, action: &str) -> Shortcut {
        Shortcut {
            chord: chord.into(),
            context,
            action: ActionId::new(action),
        }
    }

    #[test]
    fn a_letter_chord_matches_the_key_a_browser_reports() {
        // Ctrl+Alt+T arrives as `t`, so the chord text must parse to `t`.
        let plain = parse_chord("Mod+Alt+T", Platform::Other).unwrap();
        assert_eq!(plain, KeyInput::new('t', Mods::CTRL | Mods::ALT));
    }

    #[test]
    fn mod_is_command_on_mac_and_control_elsewhere() {
        assert_eq!(press("Mod+K", Platform::Mac), press("Cmd+K", Platform::Mac));
        assert_eq!(
            press("mod+k", Platform::Other),
            press("Ctrl+k", Platform::Other)
        );
        assert_ne!(
            press("Mod+K", Platform::Mac),
            press("Mod+K", Platform::Other)
        );
    }

    #[test]
    fn chords_print_for_the_platform() {
        let mac = press("Mod+Shift+Up", Platform::Mac);
        assert_eq!(format_chord(&mac, Platform::Mac), "⇧⌘Up");
        let other = press("Mod+Alt+g", Platform::Other);
        assert_eq!(format_chord(&other, Platform::Other), "Ctrl+Alt+G");
    }

    #[test]
    fn sequences_and_junk_are_refused() {
        assert!(parse_chord("Ctrl+x Ctrl+s", Platform::Other).is_err());
        assert!(parse_chord("Hyper+x", Platform::Other).is_err());
        assert!(parse_chord("", Platform::Other).is_err());
    }

    #[test]
    fn defaults_come_from_the_registry_and_resolve_by_context() {
        let reg = registry();
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &Overrides::default());
        assert_eq!(issues, vec![], "the shipped defaults must not conflict");
        let active = active_contexts(None, false);
        let picker = table.resolve(&press("Mod+Alt+T", Platform::Other), &active);
        assert_eq!(picker, Some(&ActionId::new("picker.open")));
        assert_eq!(
            table.label(&ActionId::new("picker.open")).as_deref(),
            Some("Ctrl+Alt+T")
        );
    }

    #[test]
    fn user_binding_layers_over_a_default_on_the_same_chord() {
        let reg = registry();
        let overrides = Overrides {
            bind: vec![shortcut("Mod+Alt+T", KeyContext::Global, "changes.open")],
            ..Overrides::default()
        };
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues, vec![]);
        let hit = table.resolve(
            &press("Mod+Alt+T", Platform::Other),
            &active_contexts(None, false),
        );
        assert_eq!(hit, Some(&ActionId::new("changes.open")));
    }

    #[test]
    fn unbind_removes_a_default_and_a_user_chord_shows_first() {
        let reg = registry();
        let overrides = Overrides {
            unbind: vec![Unbind {
                chord: "Mod+Alt+T".into(),
                context: KeyContext::Global,
            }],
            bind: vec![shortcut("Mod+Alt+Y", KeyContext::Global, "picker.open")],
            ..Overrides::default()
        };
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues, vec![]);
        let active = active_contexts(None, false);
        assert_eq!(
            table.resolve(&press("Mod+Alt+T", Platform::Other), &active),
            None
        );
        assert_eq!(
            table.label(&ActionId::new("picker.open")).as_deref(),
            Some("Ctrl+Alt+Y")
        );
    }

    #[test]
    fn two_user_bindings_on_one_chord_conflict_and_the_first_stays() {
        let reg = registry();
        let overrides = Overrides {
            bind: vec![
                shortcut("Mod+Alt+J", KeyContext::Global, "changes.open"),
                shortcut("Mod+Alt+J", KeyContext::Global, "files.focus"),
            ],
            ..Overrides::default()
        };
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].kind,
            IssueKind::Conflict {
                held_by: ActionId::new("changes.open")
            }
        );
        let hit = table.resolve(
            &press("Mod+Alt+J", Platform::Other),
            &active_contexts(None, false),
        );
        assert_eq!(hit, Some(&ActionId::new("changes.open")));
    }

    #[test]
    fn the_same_chord_in_different_contexts_is_not_a_conflict() {
        let reg = registry();
        let overrides = Overrides {
            bind: vec![
                shortcut("Alt+J", KeyContext::Global, "changes.open"),
                shortcut(
                    "Alt+J",
                    KeyContext::Panel {
                        kind: PanelKind::new("files"),
                    },
                    "files.focus",
                ),
            ],
            ..Overrides::default()
        };
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues, vec![]);
        let in_files = active_contexts(Some(&PanelKind::new("files")), false);
        assert_eq!(
            table.resolve(&press("Alt+J", Platform::Other), &in_files),
            Some(&ActionId::new("files.focus"))
        );
        let elsewhere = active_contexts(None, false);
        assert_eq!(
            table.resolve(&press("Alt+J", Platform::Other), &elsewhere),
            Some(&ActionId::new("changes.open"))
        );
    }

    #[test]
    fn bare_keys_cannot_take_typing() {
        let reg = registry();
        let overrides = Overrides {
            bind: vec![
                shortcut("j", KeyContext::Global, "changes.open"),
                shortcut("k", KeyContext::TextEntry, "changes.open"),
                // In a panel that is not a text surface a bare key is fine.
                shortcut(
                    "j",
                    KeyContext::Panel {
                        kind: PanelKind::new("files"),
                    },
                    "files.focus",
                ),
            ],
            ..Overrides::default()
        };
        let (table, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues.len(), 2);
        assert!(issues.iter().all(|i| i.kind == IssueKind::BareKey));
        // While typing, the files panel's bare key is not consulted at all.
        let typing = active_contexts(Some(&PanelKind::new("files")), true);
        assert_eq!(table.resolve(&press("j", Platform::Other), &typing), None);
        let browsing = active_contexts(Some(&PanelKind::new("files")), false);
        assert_eq!(
            table.resolve(&press("j", Platform::Other), &browsing),
            Some(&ActionId::new("files.focus"))
        );
    }

    #[test]
    fn unusable_saved_bindings_are_reported_not_dropped_silently() {
        let reg = registry();
        let overrides = Overrides {
            bind: vec![
                shortcut("Mod+Q", KeyContext::Global, "gone.action"),
                shortcut("Mod+Zzz+9", KeyContext::Global, "changes.open"),
            ],
            ..Overrides::default()
        };
        let (_, issues) = KeyTable::build(&reg, Platform::Other, &overrides);
        assert_eq!(issues.len(), 2);
        assert!(matches!(issues[0].kind, IssueKind::UnknownAction));
        assert!(matches!(issues[1].kind, IssueKind::InvalidChord { .. }));
        let newer = Overrides {
            version: 99,
            ..Overrides::default()
        };
        let (_, issues) = KeyTable::build(&reg, Platform::Other, &newer);
        assert_eq!(
            issues[0].kind,
            IssueKind::UnsupportedVersion { version: 99 }
        );
    }

    #[test]
    fn a_settings_screen_can_ask_who_holds_a_chord() {
        let reg = registry();
        let (table, _) = KeyTable::build(&reg, Platform::Other, &Overrides::default());
        let held = table.held_by(&shortcut("Mod+Alt+T", KeyContext::Global, "changes.open"));
        assert_eq!(held, vec![ActionId::new("picker.open")]);
        assert!(
            table
                .held_by(&shortcut("Mod+Alt+Q", KeyContext::Global, "changes.open"))
                .is_empty()
        );
    }

    #[test]
    fn overrides_serialize_for_account_sync() {
        let overrides = Overrides {
            bind: vec![shortcut(
                "Mod+Alt+J",
                KeyContext::Panel {
                    kind: PanelKind::new("files"),
                },
                "files.focus",
            )],
            unbind: vec![Unbind {
                chord: "Mod+Alt+T".into(),
                context: KeyContext::Global,
            }],
            ..Overrides::default()
        };
        let json = serde_json::to_string(&overrides).unwrap();
        assert_eq!(serde_json::from_str::<Overrides>(&json).unwrap(), overrides);
        // A document written before `unbind` existed still loads.
        let old: Overrides = serde_json::from_str(r#"{"version":1,"bind":[]}"#).unwrap();
        assert_eq!(old, Overrides::default());
    }
}
