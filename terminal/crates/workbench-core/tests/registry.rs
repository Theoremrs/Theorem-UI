//! Adding actions to a panel kind that is already registered.

use theorem_workbench_core::builtin;
use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::{ActionId, PanelKind};
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent::*, RegistryError};

fn shell() -> PanelKind {
    PanelKind::new("shell")
}

#[test]
fn extending_a_kind_adds_actions_that_resolve_like_registered_ones() {
    let mut registry = builtin::registry();
    let before = registry.get(&shell()).unwrap().actions.len();
    registry
        .extend_actions(
            &shell(),
            [
                ActionDescriptor::new("shell.attach", "Attach", Start)
                    .emits(EffectKind::TerminalAttach),
                ActionDescriptor::new("shell.resend", "Resend", Start)
                    .emits(EffectKind::TerminalInput),
            ],
        )
        .unwrap();
    assert_eq!(registry.get(&shell()).unwrap().actions.len(), before + 2);
    let (panel, action) = registry.action(&ActionId::new("shell.attach")).unwrap();
    assert_eq!(panel.kind, shell());
    assert_eq!(action.emits, Some(EffectKind::TerminalAttach));
}

#[test]
fn extending_refuses_a_duplicate_id_and_adds_nothing() {
    let mut registry = builtin::registry();
    let before = registry.get(&shell()).unwrap().actions.len();
    let existing = registry.get(&shell()).unwrap().actions[0].id.clone();
    let fresh =
        ActionDescriptor::new("shell.control", "Control", Start).emits(EffectKind::TerminalAttach);
    let dup = ActionDescriptor::new(existing.as_str(), "Again", Focus);
    assert_eq!(
        registry.extend_actions(&shell(), [fresh.clone(), dup]),
        Err(RegistryError::DuplicateAction(existing))
    );
    assert_eq!(registry.get(&shell()).unwrap().actions.len(), before);
    assert!(registry.action(&ActionId::new("shell.control")).is_none());
    // The same id twice among the new ones is a duplicate too.
    assert_eq!(
        registry.extend_actions(&shell(), [fresh.clone(), fresh]),
        Err(RegistryError::DuplicateAction(ActionId::new(
            "shell.control"
        )))
    );
}

#[test]
fn extending_makes_the_effect_checks_registration_makes() {
    let mut registry = builtin::registry();
    assert_eq!(
        registry.extend_actions(
            &shell(),
            [ActionDescriptor::new("shell.x", "X", Focus).emits(EffectKind::TerminalEnd)]
        ),
        Err(RegistryError::EffectOnPassiveAction(ActionId::new(
            "shell.x"
        )))
    );
    assert_eq!(
        registry.extend_actions(&shell(), [ActionDescriptor::new("shell.y", "Y", Start)]),
        Err(RegistryError::ActiveActionWithoutEffect(ActionId::new(
            "shell.y"
        )))
    );
}

#[test]
fn extending_an_unregistered_kind_is_an_error() {
    let mut registry = builtin::registry();
    let ghost = PanelKind::new("ghost");
    assert_eq!(
        registry.extend_actions(&ghost, []),
        Err(RegistryError::UnknownKind(ghost))
    );
}
