//! The agent's entry into the workbench: the request it makes and the answer it
//! gets. The request is an ordinary [`Msg::Action`] with the run as its actor,
//! so it takes the same `update` path a key does; nothing here changes what an
//! action does, it only says who asked and reports what the model did.

use serde::{Deserialize, Serialize};

use crate::ids::{ActionId, Actor, PanelInstanceId};
use crate::model::Notice;
use crate::msg::Msg;
use crate::registry::Refusal;

/// Why an agent's action was not dispatched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    UnknownAction,
    HumanOnly,
    Unavailable,
    UnknownPanel,
    /// The run id was empty: an action with no run cannot be attributed.
    EmptyRun,
}

/// What the model did with an agent's action.
///
/// `Accepted` means the action was dispatched, not that its effects
/// succeeded: those are answered later, as completions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum AgentOutcome {
    Accepted {
        /// How many effects the action emitted.
        effects: usize,
        /// The words of any notice the action raised.
        notices: Vec<String>,
    },
    Refused {
        code: RefusalCode,
        reason: String,
    },
}

impl AgentOutcome {
    fn refused(code: RefusalCode, reason: impl Into<String>) -> Self {
        Self::Refused {
            code,
            reason: reason.into(),
        }
    }
}

/// The message for an agent run's action, or the refusal when the request
/// cannot be attributed. `panel` is a panel instance id from the semantic tree.
pub fn agent_request(action: &str, run_id: &str, panel: Option<&str>) -> Result<Msg, AgentOutcome> {
    if run_id.trim().is_empty() {
        return Err(AgentOutcome::refused(
            RefusalCode::EmptyRun,
            "An agent action needs a run id to say who asked for it.",
        ));
    }
    Ok(action_msg(
        action,
        Actor::Agent {
            run_id: run_id.to_owned(),
        },
        panel,
    ))
}

/// The message that runs `action` for `actor`, aimed at `panel` when given.
/// The page's own overlay uses it with [`Actor::Human`].
pub fn action_msg(action: &str, actor: Actor, panel: Option<&str>) -> Msg {
    let id = ActionId::new(action);
    match panel {
        Some(panel) => Msg::ActionOn {
            id,
            actor,
            panel: PanelInstanceId::new(panel),
        },
        None => Msg::Action { id, actor },
    }
}

/// The answer, from the notices the action raised (see
/// [`Model::capture_notices`](crate::Model::capture_notices)) and the number of
/// effects it emitted. The first refusal wins.
pub fn agent_outcome(notices: &[Notice], effects: usize) -> AgentOutcome {
    for notice in notices {
        let code = match notice {
            Notice::Refused(Refusal::UnknownAction(_)) => RefusalCode::UnknownAction,
            Notice::Refused(Refusal::HumanOnly { .. }) => RefusalCode::HumanOnly,
            Notice::Refused(Refusal::Unavailable { .. }) | Notice::NoPanel(_) => {
                RefusalCode::Unavailable
            }
            Notice::Refused(Refusal::UnknownPanel(_)) => RefusalCode::UnknownPanel,
            _ => continue,
        };
        let reason = crate::notice::describe(notice)
            .map(|(text, _)| text)
            .unwrap_or_default();
        return AgentOutcome::refused(code, reason);
    }
    AgentOutcome::Accepted {
        effects,
        notices: notices
            .iter()
            .filter_map(|n| crate::notice::describe(n).map(|(text, _)| text))
            .collect(),
    }
}
