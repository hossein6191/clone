# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""Budget: a standing treasury that pays whatever a Clone poll executed.

The register decides which options are the same proposal and which one wins;
this contract reads that decision and moves money on it, without a pot of its
own inside the poll. It is the partition-aware result being reused by a
contract that did not run the vote.

The owner funds the treasury, then allots an amount to a poll of one Clone
register, binding the poll id and the opener address the owner already knows.
`pay(poll)` asks the register, through ordinary synchronous views, what it
already decided:

    not tallied yet                        -> refused; nothing changes, try later
    tallied, but opened by somebody else   -> the allotment returns to the treasury
    tallied (or void) with no winner       -> the allotment returns to the treasury
    tallied with a winner                  -> latched, then divided among the winning class
                                              by direct votes, exactly as the register
                                              divided its own pot

An allotment the register can never settle (no such poll, or a poll opened by
somebody else) can be cancelled by the owner at once, and a refused or
cancelled allotment can be made again for the same poll id, so a typo in the
opener is never a dead end.

A poll id on the register is never authority on its own: ids are assigned in
order, and whoever opens the next poll gets the next id. The owner names the
opener it trusts, and a poll opened by anyone else pays nobody.

No model runs here. It is a fixture: small on purpose, and here to be read.
"""

import json
import typing

from genlayer import *


@gl.evm.contract_interface
class _Payee:
    class View:
        pass

    class Write:
        pass


ERROR_EXPECTED = "[EXPECTED]"
ZERO = "0x0000000000000000000000000000000000000000"
HEX = "0123456789abcdef"

ALLOTTED = "allotted"
PAID = "paid"
RELEASED = "released"
REFUSED = "refused"
CANCELLED = "cancelled"
REUSABLE = (REFUSED, CANCELLED)     # an allotment in these states may be made again


def _fail(message: str) -> typing.NoReturn:
    raise gl.vm.UserError(ERROR_EXPECTED + " " + message)


def _low(address: typing.Any) -> str:
    return (address.as_hex if hasattr(address, "as_hex") else str(address)).lower()


def _is_address(text: str) -> bool:
    s = text.strip().lower()
    return len(s) == 42 and s.startswith("0x") and all(ch in HEX for ch in s[2:]) and s != ZERO


def _is_poll_id(text: str) -> bool:
    """Exactly the ids the register assigns: P, then 1 to 9 ASCII digits with no leading zero.

    `str.isdigit` would also accept "P\u00b2" or Arabic-Indic digits, and "P01"
    is not "P1": the register never reaches such an id, and an allotment to it
    could never be paid.
    """
    digits = text[1:]
    return (len(text) >= 2 and len(digits) <= 9 and text[0] == "P" and digits[0] != "0"
            and all(ch in "0123456789" for ch in digits))


def _divide(amount: int, shares: typing.List[typing.Any], winner: str) -> typing.List[typing.List[typing.Any]]:
    """[payee, amount] per share, in proportion to its direct weight; the remainder to the executed option.

    The same rule the register applies to its own pot.
    """
    total = sum(int(s["weight"]) for s in shares)
    out = []
    given = 0
    for s in shares:
        part = (amount * int(s["weight"])) // total if total > 0 else 0
        given += part
        out.append([str(s["payee"]).lower(), part, str(s["option"])])
    for row in out:
        if row[2] == winner:
            row[1] += amount - given
    return [[payee, part] for payee, part, _ in out if part > 0]


class Budget(gl.Contract):
    register: Address
    owner: Address
    free: u256              # funded and not allotted
    allotments: TreeMap[str, str]   # poll id -> JSON {opener, amount, state, to, why}
    allotment_order: DynArray[str]

    def __init__(self, register: str) -> None:
        if not _is_address(str(register)):
            _fail("the register is a 0x address of 40 hex digits")
        self.register = Address(str(register).strip())
        self.owner = gl.message.sender_address
        self.free = u256(0)

    @gl.public.write.payable
    def fund(self) -> str:
        """Add to the treasury. Anybody may; the money is the owner's to allot from then on."""
        value = gl.message.value
        if value == u256(0):
            return json.dumps({"ok": False, "reason": "send an amount greater than zero"})
        self.free = u256(int(self.free) + int(value))
        return json.dumps({"ok": True, "free": str(int(self.free))})

    @gl.public.write
    def allot(self, poll_id: str, opener: str, amount: str) -> str:
        """The owner reserves an amount for one poll, bound to the opener address it knows. Once per poll."""
        if _low(gl.message.sender_address) != _low(self.owner):
            _fail("only the owner allots the treasury")
        poll_id = str(poll_id).strip()
        if not _is_poll_id(poll_id):
            _fail("a poll id is P followed by digits")
        again = poll_id in self.allotments
        if again and json.loads(str(self.allotments[poll_id]))["state"] not in REUSABLE:
            _fail(poll_id + " already has an allotment")
        if not _is_address(str(opener)):
            _fail("the opener is a 0x address of 40 hex digits")
        text = str(amount).strip()
        if not text or not all(ch in "0123456789" for ch in text) or int(text) == 0:
            _fail("the amount is a whole number of atto greater than zero")
        if int(text) > int(self.free):
            _fail("the treasury holds " + str(int(self.free)) + " atto that is not already allotted")
        self.free = u256(int(self.free) - int(text))
        self.allotments[poll_id] = json.dumps({"opener": str(opener).strip().lower(), "amount": text,
                                               "state": ALLOTTED, "to": [], "why": ""})
        if not again:
            self.allotment_order.append(poll_id)
        return json.dumps({"ok": True, "poll": poll_id, "amount": text, "free": str(int(self.free))})

    @gl.public.write
    def pay(self, poll_id: str) -> str:
        """Pay the payee the register named for this poll, once. Anybody may call it.

        The caller chooses nothing: the payee, the amount and the poll are
        already fixed by the register and the owner's allotment.
        """
        poll_id = str(poll_id).strip()
        if poll_id not in self.allotments:
            _fail("no allotment for " + poll_id[:12])
        row = json.loads(str(self.allotments[poll_id]))
        if row["state"] != ALLOTTED:
            _fail(poll_id + " is already " + str(row["state"]))
        seen = json.loads(str(gl.get_contract_at(self.register).view().result(poll_id)))
        if not seen.get("final", False):
            _fail("the register has not tallied " + poll_id + " yet; nothing is paid before the tally")
        amount = int(row["amount"])
        if str(seen.get("opener", "")).lower() != row["opener"]:
            row["state"] = REFUSED
            row["why"] = "opened by " + str(seen.get("opener", ""))[:42] + ", not the opener this allotment was bound to"
            self.allotments[poll_id] = json.dumps(row)
            self.free = u256(int(self.free) + amount)
            return json.dumps({"ok": False, "poll": poll_id, "reason": row["why"] + "; the amount returned to the treasury"})
        shares = seen.get("shares", [])
        winner = str(seen.get("winner", ""))
        if (not winner or not isinstance(shares, list) or not shares
                or not all(isinstance(s, dict) and _is_address(str(s.get("payee", ""))) for s in shares)):
            row["state"] = RELEASED
            row["why"] = "the poll ended with no winner"
            self.allotments[poll_id] = json.dumps(row)
            self.free = u256(int(self.free) + amount)
            return json.dumps({"ok": False, "poll": poll_id, "reason": row["why"] + "; the amount returned to the treasury"})
        parts = _divide(amount, shares, winner)
        row["state"] = PAID
        row["to"] = parts
        row["why"] = "divided inside the class of " + winner[:8] + " by direct votes"
        self.allotments[poll_id] = json.dumps(row)
        for payee, part in parts:
            _Payee(Address(payee)).emit_transfer(value=u256(part))
        return json.dumps({"ok": True, "poll": poll_id, "winner": winner[:8], "to": parts, "amount": str(amount)})

    @gl.public.write
    def cancel(self, poll_id: str) -> str:
        """The owner takes back an allotment the register can never settle for it.

        Allowed while the register has no such poll, or once the poll exists
        but was opened by somebody other than the bound opener. A poll opened
        by the bound opener always ends (every window has a deadline anyone may
        act on), so its allotment waits for `pay` and cannot be cancelled.
        """
        if _low(gl.message.sender_address) != _low(self.owner):
            _fail("only the owner cancels an allotment")
        poll_id = str(poll_id).strip()
        if poll_id not in self.allotments:
            _fail("no allotment for " + poll_id[:12])
        row = json.loads(str(self.allotments[poll_id]))
        if row["state"] != ALLOTTED:
            _fail(poll_id + " is already " + str(row["state"]))
        seen = json.loads(str(gl.get_contract_at(self.register).view().result(poll_id)))
        opener = str(seen.get("opener", "")).lower()
        if opener == row["opener"]:
            _fail(poll_id + " was opened by the bound opener; it always ends, so wait and call pay")
        row["state"] = CANCELLED
        row["why"] = ("the register has no " + poll_id[:12]) if not opener else ("opened by " + opener[:42] + ", not the bound opener")
        self.allotments[poll_id] = json.dumps(row)
        self.free = u256(int(self.free) + int(row["amount"]))
        return json.dumps({"ok": True, "poll": poll_id, "state": CANCELLED, "free": str(int(self.free))})

    @gl.public.write
    def withdraw(self, amount: str) -> str:
        """The owner takes back money that is not allotted."""
        if _low(gl.message.sender_address) != _low(self.owner):
            _fail("only the owner withdraws")
        text = str(amount).strip()
        if not text or not all(ch in "0123456789" for ch in text) or int(text) == 0 or int(text) > int(self.free):
            _fail("the owner may withdraw 1 to " + str(int(self.free)) + " atto")
        self.free = u256(int(self.free) - int(text))
        _Payee(self.owner).emit_transfer(value=u256(int(text)))
        return json.dumps({"ok": True, "withdrawn": text, "free": str(int(self.free))})

    @gl.public.view
    def allotment(self, poll_id: str) -> str:
        poll_id = str(poll_id).strip()
        if poll_id not in self.allotments:
            return json.dumps({"error": "no allotment for " + poll_id[:12]})
        return json.dumps({"poll": poll_id, **json.loads(str(self.allotments[poll_id]))})

    @gl.public.view
    def treasury(self) -> str:
        return json.dumps({"register": _low(self.register), "owner": _low(self.owner), "free": str(int(self.free)),
                           "polls": [str(x) for x in self.allotment_order]})
