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
    /// The action's arguments were not what it takes: a missing task, an
    /// option it does not know, or arguments that are not JSON.
    InvalidArgs,
    /// The agent named no panel and more than one could be meant; the reason
    /// lists the candidates' panel ids (API-06). Nothing was done.
    AmbiguousTarget,
}

/// What an action takes besides its id and its panel. Most actions take
/// nothing; the coding actions take the task or the words to send as `input`
/// and a choice such as the coding agent as `option`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ActionArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub option: Option<String>,
}

impl ActionArgs {
    /// The arguments in `json`, or none when absent or blank.
    pub fn parse(json: Option<&str>) -> Result<Self, AgentOutcome> {
        match json.map(str::trim) {
            None | Some("") => Ok(Self::default()),
            Some(json) => serde_json::from_str(json).map_err(|error| {
                AgentOutcome::refused(
                    RefusalCode::InvalidArgs,
                    format!("The arguments are not {{\"input\"?, \"option\"?}}: {error}."),
                )
            }),
        }
    }

    /// The input with its outer whitespace removed, when any is left.
    pub fn input(&self) -> Option<&str> {
        self.input.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// The option, trimmed, when one was given.
    pub fn option(&self) -> Option<&str> {
        self.option.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
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
        /// The panel the action opened or acted on, when it reached one: the
        /// handle for the next action on it and for reading it in the tree.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        panel: Option<String>,
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
/// cannot be attributed or its arguments cannot be read. `panel` is a panel
/// instance id from the semantic tree; `args` is the JSON of [`ActionArgs`].
pub fn agent_request(
    action: &str,
    run_id: &str,
    panel: Option<&str>,
    args: Option<&str>,
) -> Result<Msg, AgentOutcome> {
    if run_id.trim().is_empty() {
        return Err(AgentOutcome::refused(
            RefusalCode::EmptyRun,
            "An agent action needs a run id to say who asked for it.",
        ));
    }
    let args = ActionArgs::parse(args)?;
    Ok(Msg::ActionWith {
        id: ActionId::new(action),
        actor: Actor::Agent {
            run_id: run_id.to_owned(),
        },
        panel: panel.map(PanelInstanceId::new),
        args,
    })
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
/// effects it emitted, and the panel it opened or acted on. The first refusal
/// wins.
pub fn agent_outcome(
    notices: &[Notice],
    effects: usize,
    panel: Option<&PanelInstanceId>,
) -> AgentOutcome {
    for notice in notices {
        let code = match notice {
            Notice::Refused(Refusal::UnknownAction(_)) => RefusalCode::UnknownAction,
            Notice::Refused(Refusal::HumanOnly { .. }) => RefusalCode::HumanOnly,
            Notice::Refused(Refusal::Unavailable { .. }) | Notice::NoPanel(_) => {
                RefusalCode::Unavailable
            }
            Notice::Refused(Refusal::UnknownPanel(_)) => RefusalCode::UnknownPanel,
            Notice::Refused(Refusal::InvalidArgs { .. }) => RefusalCode::InvalidArgs,
            Notice::Refused(Refusal::AmbiguousTarget { .. }) => RefusalCode::AmbiguousTarget,
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
        panel: panel.map(|p| p.as_str().to_owned()),
    }
}
