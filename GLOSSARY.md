# Paperclip Operations

How we run our Paperclip instance and keep watch over the agents working in it.

## Language

**Agent**:
An AI employee of a company in Paperclip that takes assigned issues and does them in runs.
_Avoid_: Worker, bot

**Standup**:
A daily, read-only report to the operator on what each agent did, what it is doing, and what needs the operator.
_Avoid_: Digest, status report

**Standup window**:
The span a standup covers: everything since the previous standup, so the first standup of a week includes the weekend.

**Needs you**:
A condition in the standup that requires the operator to act, such as a blocked issue, a pending approval, repeated failed runs, stalled work, budget near its cap, or assigned work that is not running.
_Avoid_: Alert, escalation, blocker (blocker is one kind of Needs you)

**Idle agent**:
An agent with no activity in the standup window and no Needs you item; counted but not described in the standup.

**Operator**:
The human who reads the standup and acts on Needs you items.
_Avoid_: Board, user, admin
