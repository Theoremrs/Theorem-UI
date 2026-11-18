# Durable artifact reference fixtures

Two Apps for the acceptance examples in the general-creation addendum
(section 7): an equipment-reservation App (`reservations/`) and a heat plate
App (`heat-plate/`). `test/blocks/durable-examples.test.ts` checks and
builds each one the way an authored App is built, judges its domain code
against fixed criteria, compares each feedback revision with the revision
before it (`revisions/1/`) under the same criterion, and shows reuse across a
presentation revision and invalidation by a semantic one.

**Who wrote these.** A coding agent wrote them in this repository. Theorem's
own authoring agent did not create them in a conversation. Plan work package
G3 and follow-up D of the PR 130 review need that second kind of evidence, so
these files are **reference and evaluator cases only. They do not count
toward D.** The criteria here can judge an App the authoring agent produces
from the same request.

| Example      | Feedback                                   | Revision 1                                                                  | Revision 2                                                                               |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Reservations | "I cannot see why this booking conflicts." | `refusal.ts` names no booking                                               | Names each booking in the way, its holder and the shared window; the rules are unchanged |
| Heat plate   | "The edge cools too quickly."              | `cellBiot` omits the cell spacing, so the convective boundary is too strong | Correct ghost-node boundary; the analytic cooled-rod case passes within 1e-9             |
