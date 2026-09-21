# Contracts

## Clone (`contracts/clone.py`)

### Purpose

A canonical answer, reached under consensus, to "which of these options are the same proposal", and a
ballot that uses it: votes are summed per class, so a reworded copy the network recognises does not
split its project's vote, and the pot is divided inside the winning class by direct votes, so a copy is
paid only for the votes cast for it. Runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`,
GenLayer Studio (chain 61999).

### Consensus

`merge(poll)` runs one `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`:

- Reading 1: options in id order, lettered A..; per option, the letter of an option proposing the same
  thing. Reading 2: the same, lettered P.. (no label shared with reading 1), in a derangement of the
  first order chosen by `sha256(poll id, closed_at, option digests)`.
- An entry missing or outside the listed labels is "itself"; a pair word other than `same` is
  `different`; only a non-object answer is a model error.
- Code joins each option with its representative, canonicalises, and takes the meet of the two readings.
- Reading 3 (only if the meet grouped something): for each pair inside a class, "do these two propose
  different things?" Each class is split so every pair left inside was called `same`.
- The leader returns `{"p": "<vector>"}`. The validator reruns the whole leader function inside
  `try/except` and agrees only on the identical string. Leader errors: identical `[EXPECTED]` messages
  agree, two `[TRANSIENT]` agree, anything else disagrees.
- Unagreed until the merge deadline: `tally` stores the identity partition with `source: fallback`.

### State

`polls: TreeMap[str, Poll]` (scalar dataclass: opener, question, voters and weights as JSON strings,
pot, status, window instants, counters, partition, partition source, result JSON, payout),
`poll_order: DynArray[str]`, `poll_count: u32`, and `TreeMap[str, str]` rows for options, one
proposal per voter, one vote per voter, option digests, and stored refusals.
Statuses: `proposing -> voting -> closed -> merged -> tallied`, or `void`.

### Methods

| method | kind | who |
|---|---|---|
| `open_poll(question, voters_csv, weights_csv, propose_minutes, vote_minutes, merge_minutes)` | write, payable | anyone (becomes the opener); windows of at least 10 minutes, a merge window of at least 35; refusals refund |
| `propose(poll, text, payee)` | write | a listed voter, once; exact copies stored as refusals |
| `close_proposals(poll)` | write | the opener once all proposed; anyone after the window |
| `vote(poll, option)` | write | a listed voter, once |
| `close_votes(poll)` | write | the opener once all voted; anyone after the window |
| `merge(poll)` | write, consensus | the opener; anyone after the grace (at least 30 minutes of it); nobody after the deadline |
| `tally(poll)` | write | anyone, once merged or after the merge deadline; divides the pot inside the winning class by direct votes |
| `poll`, `polls_list`, `options`, `refusals` | view | |
| `partition(poll)` | view | the reusable answer: `p`, classes, source |
| `plurality_winner(poll)` | view | what plain plurality picks from the same votes |
| `result(poll)` | view | `final`, winner, payee, `shares` (option, payee, direct weight, amount), class, weights, plurality winner, opener |
| `agreement_rule()` | view | the rule, as the contract states it |

### Reuse

Read `partition(poll)` for the classes, or `result(poll)` for the executed option and the shares. Bind to
the opener address you know as well as the poll id: ids are assigned in order and say nothing about who
opened a poll. `contracts/fixtures/budget.py` shows the pattern.

### Limits

2 to 6 voters, one option each, options of 8 to 280 printable ASCII characters without `<` or `>`.
Windows in minutes on the message clock, chosen by the opener above the floors. A copy counts once only
if the network recognises it; a content hijack that fools all three readings on a majority of nodes is
the residual risk, and an injection that argues options apart can force plain plurality (README).

## Budget (`contracts/fixtures/budget.py`)

### Purpose

A standing treasury that pays whatever a Clone poll executed, so the partition-aware result is reused
by a contract that did not run the vote and does not hold its pot.

### Consensus

None of its own. `pay` reads `result(poll)` from the register through a synchronous cross-contract view
and obeys it. No model runs.

### State

`register`, `owner`, `free` (funded and not allotted), `allotments: TreeMap[str, str]` (poll id ->
opener, amount, state, recipient, reason), `allotment_order`.

### Methods

| method | who | effect |
|---|---|---|
| `fund()` payable | anyone | adds to `free` |
| `allot(poll, opener, amount)` | the owner | reserves an amount for a poll id in the register's own form, bound to the opener the owner knows; again only after a refusal or a cancel |
| `pay(poll)` | anyone | not final: refused. Opened by someone else, or no winner: returned to `free`, stored, `ok: false`. Else latched, then divided among `result`'s shares by direct weight |
| `cancel(poll)` | the owner | returns an allotment while the register has no such poll, or once it shows a poll opened by somebody else |
| `withdraw(amount)` | the owner | from `free` only |
| `allotment(poll)`, `treasury()` | view | |

### Reuse

Deploy with the register address; the owner allots per poll, before or after it is opened.

### Limits

It trusts the register it was deployed with and the opener the owner names; it decides nothing else.
