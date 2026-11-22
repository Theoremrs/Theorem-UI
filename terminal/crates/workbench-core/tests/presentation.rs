//! R48, AC-59: an alternate presentation of a document, registered through the
//! registry. The panels here are stand-ins that open and close a document the
//! way the editor and the Markdown panel do.

use std::cell::RefCell;
use std::rc::Rc;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, LayoutDocument, LayoutLoaded, LayoutSource, Outcome,
};
use theorem_workbench_core::effect::{Effect, EffectBody, EffectKind};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Actor, Capability, PanelInstanceId, PanelKind, ResourceKind, ResourceRef, Revision,
};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::picker::{Page, PickerMsg};
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, Availability, BodyKind, Capabilities, CellSize,
    PanelDescriptor, Placement, Presentation, Refusal, Registry, RegistryError,
};
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Ctx, Model, Msg, Notice, Panel, PanelFactories, PanelMsg, TabLabel, ViewCtx, semantics, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, PanelId, Preset};

type Log = Rc<RefCell<Vec<String>>>;

/// A panel of one document, bound to it from the first moment. It asks to open
/// the document on its first tick and to close it when it is torn down.
struct DocPanel {
    kind: &'static str,
    workspace: String,
    path: String,
    dirty: bool,
    opened: bool,
    log: Log,
}

impl DocPanel {
    fn resource(&self) -> ResourceRef {
        ResourceRef::Document {
            workspace: self.workspace.clone(),
            resource_id: self.path.clone(),
        }
    }
}

impl Panel for DocPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        let resource = self.resource();
        match msg {
            PanelMsg::Tick if !self.opened => {
                self.opened = true;
                let _ = cx.emit(|id| {
                    Effect::new(
                        id,
                        resource,
                        EffectBody::DocumentOpen(theorem_workbench_core::effect::DocumentOpen {
                            seed_text: None,
                        }),
                    )
                });
            }
            PanelMsg::Key(k) if k.key() == Key::Char('z') => self.dirty = true,
            PanelMsg::Key(k) if k.key() == Key::Char('s') => {
                let _ = cx.emit(|id| Effect::new(id, resource, EffectBody::DocumentSave));
            }
            _ => {}
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        buf.set_stringn(
            area.x,
            area.y,
            self.kind,
            usize::from(area.width),
            cx.theme.text,
        );
    }

    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new("root", Role::Document, self.kind, area)]
    }

    fn serialize(&self) -> Value {
        json!({ "workspace": self.workspace, "path": self.path, "view": self.kind })
    }

    fn tab_label(&self) -> Option<TabLabel> {
        Some(TabLabel {
            title: self.path.clone(),
            modified: self.dirty,
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: None,
        })
    }

    fn teardown(&mut self, cx: &mut Ctx, destroy: bool) {
        self.log
            .borrow_mut()
            .push(format!("teardown {} destroy={destroy}", self.kind));
        let resource = self.resource();
        let _ = cx.emit(|id| Effect::new(id, resource, EffectBody::DocumentClose));
    }
}

fn descriptor(kind: &str, requires: &[&str], actions: Vec<ActionDescriptor>) -> PanelDescriptor {
    PanelDescriptor {
        kind: PanelKind::new(kind),
        version: 1,
        title: format!("{} view", kind),
        icon: "x".into(),
        body: BodyKind::Drawn,
        binding: ResourceKind::Document,
        actions,
        requires: requires.iter().map(|c| Capability::new(*c)).collect(),
        min_size: CellSize { cols: 10, rows: 4 },
        default_placement: Placement::Main,
        theme_roles: vec![],
        semantic_role: Role::Document,
    }
}

/// `text` shows every document and is the default; `preview` shows Markdown;
/// `rich` shows Markdown too and needs a capability the host has not granted.
fn registry() -> Registry {
    let mut registry = builtin::registry();
    for (kind, requires) in [
        ("text", &[][..]),
        ("preview", &[][..]),
        ("rich", &["rich.render"][..]),
    ] {
        registry
            .register(descriptor(
                kind,
                requires,
                vec![ActionDescriptor::new(
                    &format!("{kind}.open"),
                    "Open",
                    ActionIntent::Open,
                )],
            ))
            .unwrap();
    }
    registry
}

fn declare(registry: &mut Registry) {
    registry
        .declare_presentation(
            Presentation::new("text", ResourceKind::Document).default_presentation(),
        )
        .unwrap();
    registry
        .declare_presentation(
            Presentation::new("preview", ResourceKind::Document).extensions(["md", "markdown"]),
        )
        .unwrap();
    registry
        .declare_presentation(Presentation::new("rich", ResourceKind::Document).extensions(["md"]))
        .unwrap();
}

fn factories(log: &Log, kinds: &[&'static str]) -> PanelFactories {
    let mut factories = PanelFactories::new();
    for kind in kinds {
        let (kind, log) = (*kind, log.clone());
        factories.register(kind, move |state, _| {
            Box::new(DocPanel {
                kind,
                workspace: state["workspace"].as_str().unwrap_or("w").to_owned(),
                path: state["path"].as_str().unwrap_or("a.md").to_owned(),
                dirty: false,
                opened: false,
                log: log.clone(),
            })
        });
    }
    factories
}

fn model_with(
    registry: Registry,
    kinds: &[&'static str],
    caps: &'static [&'static str],
) -> (Model, Log) {
    let log: Log = Rc::default();
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(
        registry,
        factories(&log, kinds),
        keys,
        Capabilities::of(caps.iter().copied()),
        dock,
    );
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    (m, log)
}

fn model() -> (Model, Log) {
    let mut registry = registry();
    declare(&mut registry);
    model_with(registry, &["text", "preview", "rich"], &["documents"])
}

fn send(m: &mut Model, msg: Msg) -> Vec<Effect> {
    update(m, msg)
}

fn act_as(m: &mut Model, id: &str, actor: Actor, on: Option<&PanelInstanceId>) -> Vec<Effect> {
    let id = ActionId::new(id);
    match on {
        Some(panel) => send(
            m,
            Msg::ActionOn {
                id,
                actor,
                panel: panel.clone(),
            },
        ),
        None => send(m, Msg::Action { id, actor }),
    }
}

fn act(m: &mut Model, id: &str, on: Option<&PanelInstanceId>) -> Vec<Effect> {
    act_as(m, id, Actor::Human, on)
}

fn agent() -> Actor {
    Actor::Agent {
        run_id: "run-1".into(),
    }
}

fn doc(path: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: "w".into(),
        resource_id: path.into(),
    }
}

fn kind_of(m: &Model, id: &PanelInstanceId) -> String {
    m.panel_ids()
        .find(|(p, _)| *p == id)
        .map(|(_, k)| k.as_str().to_owned())
        .expect("the panel is open")
}

fn ids_of(m: &Model, kind: &str) -> Vec<PanelInstanceId> {
    m.panel_ids()
        .filter(|(_, k)| k.as_str() == kind)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Where the panel's tab is: its group and its place in the strip.
fn place_of(m: &Model, id: &PanelInstanceId) -> (u32, usize) {
    let panel = PanelId(id.as_str().to_owned());
    let group = m.dock().find_panel(&panel).expect("in a group");
    let at = m
        .dock()
        .group(group)
        .unwrap()
        .tabs()
        .iter()
        .position(|t| t.panel == panel)
        .unwrap();
    (group.raw(), at)
}

fn tab_kind(m: &Model, id: &PanelInstanceId) -> (String, u32) {
    let panel = PanelId(id.as_str().to_owned());
    let group = m.dock().find_panel(&panel).unwrap();
    let tab = m
        .dock()
        .group(group)
        .unwrap()
        .tabs()
        .iter()
        .find(|t| t.panel == panel)
        .unwrap();
    (tab.kind.name.clone(), tab.kind.version)
}

fn binding_of(m: &Model, id: &PanelInstanceId) -> Option<Binding> {
    m.panel(id).and_then(|p| p.binding())
}

fn refusal(m: &mut Model) -> Option<String> {
    std::iter::from_fn(|| m.take_captured().pop())
        .collect::<Vec<_>>()
        .into_iter()
        .find_map(|n| match n {
            Notice::Refused(Refusal::Unavailable { reason }) => Some(reason),
            _ => None,
        })
}

/// Run `f` and return the reason a refusal gave, if one was raised.
fn refused(m: &mut Model, f: impl FnOnce(&mut Model)) -> Option<String> {
    m.capture_notices();
    f(m);
    refusal(m)
}

/// Open a `text` panel on a.md, let it ask for the document and settle that.
fn open_text(m: &mut Model) -> PanelInstanceId {
    let before = ids_of(m, "text");
    act(m, "text.open", None);
    let id = ids_of(m, "text")
        .into_iter()
        .find(|id| !before.contains(id))
        .expect("a text panel opened");
    settle(m, &id);
    id
}

fn settle(m: &mut Model, panel: &PanelInstanceId) {
    let _ = panel;
    let effects = send(m, Msg::Tick);
    for e in effects
        .iter()
        .filter(|e| e.kind() == EffectKind::DocumentOpen)
    {
        send(
            m,
            Msg::Completion(Completion::new(e.id, e.resource.clone(), Outcome::Accepted)),
        );
    }
}

fn type_in(m: &mut Model, c: char) {
    send(m, Msg::Key(KeyInput::new(Key::Char(c), Mods::NONE)));
}

// ---- the registry answers which presentations can show a resource -------

#[test]
fn the_registry_lists_presentations_by_resource_declared_match_and_granted_capability() {
    let mut r = registry();
    // Declared out of order: the default is still first.
    r.declare_presentation(
        Presentation::new("preview", ResourceKind::Document).extensions(["md", "markdown"]),
    )
    .unwrap();
    r.declare_presentation(Presentation::new("rich", ResourceKind::Document).extensions(["md"]))
        .unwrap();
    r.declare_presentation(
        Presentation::new("text", ResourceKind::Document).default_presentation(),
    )
    .unwrap();
    let caps = Capabilities::of(["documents"]);
    let kinds = |resource: &ResourceRef, caps: &Capabilities| -> Vec<(String, bool)> {
        r.presentations_for(resource, caps)
            .into_iter()
            .map(|e| (e.kind.as_str().to_owned(), e.availability.is_available()))
            .collect()
    };

    assert_eq!(
        kinds(&doc("notes/a.md"), &caps),
        [
            ("text".to_owned(), true),
            ("preview".to_owned(), true),
            ("rich".to_owned(), false),
        ],
        "the default first, then declaration order; the one that needs a capability is listed, unavailable"
    );
    assert_eq!(
        kinds(&doc("notes/a.markdown"), &caps)
            .iter()
            .map(|(k, _)| k.as_str())
            .collect::<Vec<_>>(),
        ["text", "preview"],
        "the declared match is by extension"
    );
    assert_eq!(
        kinds(&doc("notes/A.MD"), &caps).len(),
        3,
        "case does not matter"
    );
    assert_eq!(kinds(&doc("src/a.rs"), &caps), [("text".to_owned(), true)]);
    assert_eq!(
        kinds(&doc("README"), &caps),
        [("text".to_owned(), true)],
        "a document with no extension matches only what matches every document"
    );
    assert!(
        kinds(
            &ResourceRef::Terminal {
                workspace: "w".into(),
                session: "s".into()
            },
            &caps
        )
        .is_empty(),
        "a terminal is not a document"
    );

    // The reason a person can act on, and the same list once it is granted.
    let listed = r.presentations_for(&doc("a.md"), &caps);
    let rich = listed.iter().find(|e| e.kind.as_str() == "rich").unwrap();
    assert_eq!(rich.version, 1);
    let Availability::Unavailable { reason } = &rich.availability else {
        panic!("rich is unavailable");
    };
    assert!(reason.contains("rich.render"), "{reason}");
    let granted = Capabilities::of(["documents", "rich.render"]);
    assert!(
        kinds(&doc("a.md"), &granted)
            .iter()
            .all(|(_, available)| *available)
    );
}

#[test]
fn a_declaration_must_name_a_registered_kind_once_and_match_cleanly() {
    let mut r = registry();
    let p = |kind: &str| Presentation::new(kind, ResourceKind::Document);
    assert_eq!(
        r.declare_presentation(p("nope")),
        Err(RegistryError::UnknownKind(PanelKind::new("nope")))
    );
    assert_eq!(
        r.declare_presentation(Presentation::new("text", ResourceKind::Terminal)),
        Err(RegistryError::PresentationBindingMismatch(PanelKind::new(
            "text"
        )))
    );
    for bad in ["", ".md", "MD"] {
        assert!(
            matches!(
                r.declare_presentation(p("text").extensions([bad])),
                Err(RegistryError::BadExtension { .. })
            ),
            "{bad:?}"
        );
    }
    r.declare_presentation(p("text")).unwrap();
    assert_eq!(
        r.declare_presentation(p("text")),
        Err(RegistryError::DuplicatePresentation(PanelKind::new("text")))
    );
    assert_eq!(r.presentations().len(), 1, "nothing was added by a refusal");
}

#[test]
fn a_declaration_is_data_only_with_no_path_to_code_or_a_location() {
    // What a declaration is, as it travels.
    let p = Presentation::new("preview", ResourceKind::Document)
        .extensions(["md"])
        .default_presentation();
    let json = serde_json::to_value(&p).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["default", "extensions", "kind", "shows"]);
    assert_eq!(serde_json::from_value::<Presentation>(json).unwrap(), p);
    // A declaration that carries anything else is refused whole, so no field
    // can smuggle in a script, a module or an address to fetch one from.
    for extra in ["script", "module", "url", "code", "src", "credentials"] {
        let mut value = serde_json::to_value(&p).unwrap();
        value[extra] = json!("anything");
        assert!(
            serde_json::from_value::<Presentation>(value).is_err(),
            "{extra} is not part of a declaration"
        );
    }
    // The only way in is `declare_presentation(Presentation)`, which names a
    // kind registered the ordinary way; it takes no closure, no path, no URL.
    let mut r = registry();
    r.declare_presentation(p).unwrap();
    assert_eq!(r.presentations().len(), 1);
}

// ---- the swap -----------------------------------------------------------

#[test]
fn a_swap_keeps_the_panel_its_place_its_focus_and_its_binding_and_destroys_nothing() {
    let (mut m, log) = model();
    let first = open_text(&mut m);
    let target = open_text(&mut m);
    let last = open_text(&mut m);
    assert_ne!(first, target);
    act(&mut m, &format!("tab.focus.{}", target.as_str()), None);
    assert_eq!(m.focus().panel, Some(target.clone()));
    let place = place_of(&m, &target);
    let binding = binding_of(&m, &target).unwrap();
    assert_eq!(binding.resource, doc("a.md"));
    let panels_before = m.panel_ids().count();

    let effects = act(&mut m, "panel.presentation.next", None);

    // Still the one panel: its id, its tab's group and place, the focus.
    assert_eq!(kind_of(&m, &target), "preview");
    assert_eq!(place_of(&m, &target), place);
    assert_eq!(m.focus().panel, Some(target.clone()));
    assert_eq!(m.panel_ids().count(), panels_before);
    assert_eq!(kind_of(&m, &first), "text");
    assert_eq!(kind_of(&m, &last), "text");
    // The same resource, and the tab says which presentation it is.
    assert_eq!(binding_of(&m, &target).unwrap().resource, binding.resource);
    assert_eq!(tab_kind(&m, &target), ("preview".to_owned(), 1));
    assert_eq!(m.panel(&target).unwrap().serialize()["path"], "a.md");
    // Released as a kind change releases it: the view closes, the resource is
    // not destroyed, and no destroying effect was asked for.
    assert_eq!(
        log.borrow().as_slice(),
        ["teardown text destroy=false"],
        "the old panel was asked to release, not to destroy"
    );
    assert!(
        effects
            .iter()
            .all(|e| e.kind() == EffectKind::DocumentClose)
    );
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].resource, doc("a.md"));

    // The new panel opens the document as any panel of its kind does: on its
    // own first tick, through the same owner.
    let opens: Vec<Effect> = send(&mut m, Msg::Tick)
        .into_iter()
        .filter(|e| e.kind() == EffectKind::DocumentOpen)
        .collect();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].resource, doc("a.md"));
    // Until the owner has answered, the new panel is still waiting on it.
    let reason = refused(&mut m, |m| {
        act(m, "panel.presentation.next", None);
    })
    .expect("refused");
    assert!(reason.contains("waiting"), "{reason}");
    send(
        &mut m,
        Msg::Completion(Completion::new(
            opens[0].id,
            opens[0].resource.clone(),
            Outcome::Accepted,
        )),
    );

    // And back, in the same place.
    act(&mut m, "panel.presentation.next", None);
    assert_eq!(kind_of(&m, &target), "text");
    assert_eq!(place_of(&m, &target), place);
    assert_eq!(m.focus().panel, Some(target));
}

#[test]
fn a_swap_is_refused_while_the_panel_has_unsaved_changes_or_work_in_flight() {
    let (mut m, log) = model();
    let id = open_text(&mut m);

    // Unsaved changes stay where they are.
    type_in(&mut m, 'z');
    let reason = refused(&mut m, |m| {
        act(m, "panel.presentation.next", None);
    })
    .expect("refused");
    assert!(reason.contains("not saved"), "{reason}");
    assert_eq!(kind_of(&m, &id), "text");
    assert!(log.borrow().is_empty(), "the panel was not released");
    assert_eq!(
        m.panel(&id).and_then(|p| p.tab_label()).map(|l| l.modified),
        Some(true),
        "and still holds them"
    );

    // Work in flight for the document settles first.
    let (mut m, log) = model();
    let id = open_text(&mut m);
    let save = {
        let before = send(&mut m, Msg::Tick);
        assert!(before.is_empty());
        let mut effects = vec![];
        effects.extend(send(
            &mut m,
            Msg::Key(KeyInput::new(Key::Char('s'), Mods::NONE)),
        ));
        effects
    };
    assert_eq!(save.len(), 1);
    let reason = refused(&mut m, |m| {
        act(m, "panel.presentation.next", None);
    })
    .expect("refused");
    assert!(reason.contains("waiting"), "{reason}");
    assert_eq!(kind_of(&m, &id), "text");
    assert!(log.borrow().is_empty());
    // Answered: the swap goes through.
    send(
        &mut m,
        Msg::Completion(Completion::new(
            save[0].id,
            save[0].resource.clone(),
            Outcome::Accepted,
        )),
    );
    act(&mut m, "panel.presentation.next", None);
    assert_eq!(kind_of(&m, &id), "preview");
}

#[test]
fn a_presentation_that_needs_an_ungranted_capability_cannot_be_chosen_by_a_person_or_an_agent() {
    let (mut m, log) = model();
    let id = open_text(&mut m);
    for actor in [Actor::Human, agent()] {
        let reason = refused(&mut m, |m| {
            act_as(m, "panel.presentation.use:rich", actor.clone(), Some(&id));
        })
        .unwrap_or_else(|| panic!("{actor:?} was refused"));
        assert!(reason.contains("rich.render"), "{reason}");
        assert_eq!(kind_of(&m, &id), "text", "{actor:?}");
    }
    assert!(log.borrow().is_empty());
    // A kind that cannot show the document is refused the same way.
    let reason = refused(&mut m, |m| {
        act_as(m, "panel.presentation.use:term", agent(), Some(&id));
    })
    .expect("refused");
    assert!(reason.contains("cannot show"), "{reason}");
    // `next` passes it by: the only other available way is the preview.
    act(&mut m, "panel.presentation.next", None);
    assert_eq!(kind_of(&m, &id), "preview");
    settle(&mut m, &id);
    act(&mut m, "panel.presentation.next", None);
    assert_eq!(kind_of(&m, &id), "text", "never rich");
    settle(&mut m, &id);

    // Granted, it is the same list with one more way to choose.
    send(
        &mut m,
        Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["documents", "rich.render"]),
        }),
    );
    act_as(&mut m, "panel.presentation.use:rich", agent(), Some(&id));
    assert_eq!(kind_of(&m, &id), "rich");
}

#[test]
fn an_agent_may_switch_presentation_it_is_not_a_mutation() {
    let (mut m, _) = model();
    let id = open_text(&mut m);
    let catalog = m.registry().agent_catalog(m.capabilities());
    for action in ["panel.presentation", "panel.presentation.next"] {
        let entry = catalog
            .iter()
            .find(|e| e.action.as_str() == action)
            .unwrap_or_else(|| panic!("{action} is in the agent's catalog"));
        assert!(!entry.human_only);
        assert!(entry.availability.is_available());
    }
    m.capture_notices();
    let effects = act_as(&mut m, "panel.presentation.next", agent(), Some(&id));
    assert!(
        effects
            .iter()
            .all(|e| e.kind() == EffectKind::DocumentClose),
        "nothing but the release: {effects:?}"
    );
    assert_eq!(kind_of(&m, &id), "preview");
    assert!(refusal(&mut m).is_none());
}

#[test]
fn the_chooser_lists_every_way_marks_the_current_and_swaps_on_choose() {
    let (mut m, _) = model();
    let id = open_text(&mut m);
    let effects = act(&mut m, "panel.presentation", None);
    assert!(
        effects.is_empty(),
        "choosing a way has no effect of its own"
    );
    assert!(m.picker().is_open());
    assert_eq!(m.picker().page(), Page::Presentations);
    let rows = m.picker().rows(m.registry(), m.capabilities(), m.pinned());
    let listed: Vec<(&str, bool, bool)> = rows
        .iter()
        .map(|r| {
            (
                r.panel.as_str(),
                r.availability.is_available(),
                r.glyph.is_some(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            ("text", true, true),
            ("preview", true, false),
            ("rich", false, false)
        ]
    );
    assert_eq!(rows[0].action.as_str(), "panel.presentation.use:text");

    // The unavailable one says why and stays put.
    send(&mut m, Msg::Picker(PickerMsg::Select(2)));
    m.capture_notices();
    send(&mut m, Msg::Picker(PickerMsg::Choose));
    assert!(refusal(&mut m).unwrap().contains("rich.render"));
    assert_eq!(kind_of(&m, &id), "text");
    assert!(m.picker().is_open());

    // The preview is chosen: the chooser closes, the keyboard is back on the
    // panel, and it shows the document the other way.
    send(&mut m, Msg::Picker(PickerMsg::Select(1)));
    send(&mut m, Msg::Picker(PickerMsg::Choose));
    assert!(!m.picker().is_open());
    assert_eq!(kind_of(&m, &id), "preview");
    assert_eq!(m.focus().panel, Some(id.clone()));
    assert_eq!(binding_of(&m, &id).unwrap().resource, doc("a.md"));

    // Escape leaves it as it was.
    act(&mut m, "panel.presentation", None);
    send(&mut m, Msg::Picker(PickerMsg::Back));
    assert!(!m.picker().is_open());
    assert_eq!(kind_of(&m, &id), "preview");
}

#[test]
fn semantics_name_the_current_presentation_and_offer_each_way_with_its_reason() {
    let (mut m, _) = model();
    let id = open_text(&mut m);
    let tab = |m: &Model| -> Node {
        semantics(m)
            .nodes
            .into_iter()
            .find(|n| n.id.as_str() == format!("tab:{}", id.as_str()))
            .expect("the tab is on the tree")
    };
    let node = tab(&m);
    assert_eq!(
        node.state.description.as_deref(),
        Some("Shown as text view (version 1)")
    );
    let action = |node: &Node, id: &str| {
        node.actions
            .iter()
            .find(|a| a.id.as_str() == id)
            .unwrap_or_else(|| panic!("{id} is offered"))
            .clone()
    };
    assert!(action(&node, "panel.presentation").enabled);
    assert!(action(&node, "panel.presentation.next").enabled);
    assert!(action(&node, "panel.presentation.use:preview").enabled);
    let rich = action(&node, "panel.presentation.use:rich");
    assert!(!rich.enabled);
    assert!(rich.reason.unwrap().contains("rich.render"));
    let text = action(&node, "panel.presentation.use:text");
    assert!(!text.enabled, "the way it is shown now");

    act(&mut m, "panel.presentation.next", None);
    assert_eq!(
        tab(&m).state.description.as_deref(),
        Some("Shown as preview view (version 1)")
    );
}

// ---- persistence ----------------------------------------------------------

#[test]
fn a_saved_layout_records_the_presentation_and_brings_a_known_one_back() {
    let (mut m, _) = model();
    let id = open_text(&mut m);
    act(&mut m, "panel.presentation.next", None);
    let saved = m.document();
    let tab = saved["dock"]["groups"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|g| g["tabs"].as_array().unwrap())
        .find(|t| t["panel"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(tab["kind"], json!({ "name": "preview", "version": 1 }));
    assert_eq!(tab["view_state"]["path"], "a.md");

    let (mut again, _) = model();
    again.restore(saved).unwrap();
    assert_eq!(kind_of(&again, &id), "preview");
    assert!(!again.is_unavailable(&id));
    assert_eq!(binding_of(&again, &id).unwrap().resource, doc("a.md"));
}

/// The layout of a model with one `text` panel, its tab rewritten to name
/// `kind` at `version`.
fn layout_naming(kind: &str, version: u32) -> (Value, PanelInstanceId) {
    let (mut m, _) = model();
    let id = open_text(&mut m);
    let mut saved = m.document();
    for group in saved["dock"]["groups"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        for tab in group["tabs"].as_array_mut().unwrap() {
            if tab["panel"] == id.as_str() {
                tab["kind"] = json!({ "name": kind, "version": version });
            }
        }
    }
    (saved, id)
}

#[test]
fn an_unknown_presentation_or_an_incompatible_version_restores_as_a_placeholder_with_a_way_back() {
    for (kind, version, wanted) in [
        ("holo", 3, "\"holo\" (saved at version 3)"),
        ("preview", 9, "newer version (9) of \"preview\""),
    ] {
        let (saved, id) = layout_naming(kind, version);
        let kept = saved["dock"]["groups"]
            .as_object()
            .unwrap()
            .values()
            .flat_map(|g| g["tabs"].as_array().unwrap())
            .find(|t| t["panel"] == id.as_str())
            .unwrap()["view_state"]
            .clone();
        let (mut m, log) = model();
        m.restore(saved.clone()).unwrap();

        // A placeholder, not a guess at another panel; it says which
        // presentation and version it wanted, and keeps the state byte for byte.
        assert!(m.is_unavailable(&id), "{kind}@{version}");
        assert_ne!(kind_of(&m, &id), "text", "never mapped to the default");
        assert_eq!(m.panel(&id).unwrap().serialize(), kept);
        let reason = semantics(&m)
            .nodes
            .iter()
            .find_map(|n| n.state.description.clone().filter(|d| d.contains(wanted)))
            .unwrap_or_else(|| panic!("the placeholder names {wanted}"));
        assert!(reason.contains("panel.presentation"), "{reason}");
        // The tab still names the presentation it wanted.
        assert_eq!(tab_kind(&m, &id), (kind.to_owned(), version));
        // No effect for it, ever.
        for _ in 0..3 {
            assert!(send(&mut m, Msg::Tick).is_empty());
        }
        assert!(log.borrow().is_empty());

        // The binding is kept: the way back lists what can show the document.
        let listed = m.presentations_of(&id);
        assert_eq!(
            listed.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["text", "preview", "rich"]
        );
        assert!(listed.iter().all(|e| !e.current));
        let (place, panels) = (place_of(&m, &id), m.panel_ids().count());
        let node = semantics(&m)
            .nodes
            .into_iter()
            .find(|n| n.id.as_str() == format!("tab:{}", id.as_str()))
            .unwrap();
        assert!(
            node.actions
                .iter()
                .any(|a| a.id.as_str() == "panel.presentation" && a.enabled)
        );

        // The person picks one: the same panel, tab and document.
        act(&mut m, "panel.presentation", Some(&id));
        assert_eq!(m.picker().page(), Page::Presentations);
        send(&mut m, Msg::Picker(PickerMsg::Choose));
        assert_eq!(kind_of(&m, &id), "text", "{kind}@{version}");
        assert!(!m.is_unavailable(&id));
        assert_eq!(place_of(&m, &id), place);
        assert_eq!(m.panel_ids().count(), panels);
        assert_eq!(binding_of(&m, &id).unwrap().resource, doc("a.md"));
        assert_eq!(tab_kind(&m, &id), ("text".to_owned(), 1));
        assert!(!send(&mut m, Msg::Tick).is_empty(), "now it opens a.md");
    }
}

#[test]
fn a_saved_arrangement_keeps_a_document_placeholder_for_a_presentation_this_build_lacks() {
    let (saved, id) = layout_naming("holo", 3);
    let (mut m, _) = model();
    let load = send(
        &mut m,
        Msg::Arrangement(theorem_workbench_core::ArrangementMsg::Load),
    );
    assert_eq!(load[0].kind(), EffectKind::LayoutLoad);
    let named = json!({
        "schema": "theorem.workbench.arrangements", "version": 1,
        "items": [{"name": "Reading", "document": saved}]
    })
    .to_string();
    send(
        &mut m,
        Msg::Completion(
            Completion::new(load[0].id, ResourceRef::None, Outcome::Accepted).with_payload(
                CompletionPayload::LayoutLoaded(LayoutLoaded {
                    source: LayoutSource::Account,
                    revision: Revision::Seq(4),
                    document: Some(LayoutDocument {
                        current: String::new(),
                        named_layouts: named,
                    }),
                }),
            ),
        ),
    );
    send(
        &mut m,
        Msg::Arrangement(theorem_workbench_core::ArrangementMsg::Apply {
            name: "Reading".into(),
        }),
    );
    let placeholder = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "holo")
        .map(|(id, _)| id.clone())
        .expect("kept, not dropped");
    assert!(m.is_unavailable(&placeholder));
    assert_eq!(m.presentations_of(&placeholder).len(), 3);
    assert!(
        m.panel(&placeholder).unwrap().serialize()["path"] == "a.md",
        "{id:?}: the document it shows is kept"
    );
    act(&mut m, "panel.presentation.next", Some(&placeholder));
    assert_eq!(kind_of(&m, &placeholder), "text");
}

#[test]
fn a_panel_with_no_document_has_nothing_to_swap() {
    let (mut m, _) = model();
    let reason = refused(&mut m, |m| {
        act(m, "panel.presentation.next", None);
    })
    .expect("refused");
    assert!(reason.contains("document"), "{reason}");
    let id = open_text(&mut m);
    assert!(m.presentations_of(&PanelInstanceId::new("nope")).is_empty());
    // A kind nothing is declared for lists nothing.
    let mut r = registry();
    r.declare_presentation(
        Presentation::new("text", ResourceKind::Document).default_presentation(),
    )
    .unwrap();
    let (mut only, _) = model_with(r, &["text", "preview", "rich"], &["documents"]);
    let id2 = open_text(&mut only);
    let reason = refused(&mut only, |m| {
        act(m, "panel.presentation.next", None);
    })
    .expect("refused");
    assert!(reason.contains("No other presentation"), "{reason}");
    assert_eq!(kind_of(&only, &id2), "text");
    let _ = id;
}
