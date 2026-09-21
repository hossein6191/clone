/* Clone against GenLayer Studio (chain 61999), with throwaway accounts. Deploys its own copy.
 *
 *   npm ci                                        # genlayer-js 1.1.8 and viem 2.56.8, pinned by package-lock.json
 *   node tests/on_chain/smoke.mjs                 # everything, on a fresh deployment
 *   PHASE=C node tests/on_chain/smoke.mjs         # continue from one phase (A, B, C, D or E) with the saved state
 *
 * Five polls, all opened by the same throwaway opener:
 *   P1  the copy: a reworded copy of the Riverside proposal is merged with it, and the
 *       class beats the plurality winner; the pot is divided inside the class by direct
 *       votes, and the Budget fixture divides its allotment the same way.
 *   P2  the near-miss and the letter hijack: nothing merges; merged by a voter after the grace.
 *   P3  the fallback: nobody merges, the 35-minute merge window passes, the tally is plain plurality.
 *   P4  void: one proposal when the 10-minute window ends, the pot goes back.
 *   P5  (phase E) more specific AND somewhere else: solar lamps on the bridge against lighting
 *       the Riverside footpath stay apart, so the specificity rule does not over-merge; and a
 *       Budget allotment for a poll the register does not have is cancelled by the owner.
 * Every refusal is a signed transaction; every payout is read from balances after finalisation.
 * Transactions are polled with eth_getTransactionByHash (300/min bucket), never with views
 * (gen_call is limited to 30 per minute per client).
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = "https://studio.genlayer.com/api";
const STATE = process.env.STATE || join(tmpdir(), "clone-smoke-state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (m, p) => { let last; for (let i = 0; i < 8; i++) { try { const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error && j.error.code === -32029) { await sleep(((j.error.data?.retry_after_seconds) || 20) * 1000); continue; } return j.result; } catch (e) { last = e; await sleep(2500); } } throw last; };
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  - " + d : ""}`); };
const GEN = 10n ** 18n;
const tally = (r) => `${r.votes.agree} agree, ${r.votes.disagree} disagree, ${r.votes.idle} idle`;
const stamp = () => new Date().toISOString().slice(11, 19);

// ---------- state: accounts, addresses and poll ids survive between phases ----------
const st = existsSync(STATE) && process.env.PHASE ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
for (const k of ["a", "b", "c", "s"]) st[k] = st[k] || generatePrivateKey();
const A = createAccount(st.a), B = createAccount(st.b), C = createAccount(st.c), S = createAccount(st.s);
const ca = createClient({ chain: studionet, account: A }), cb = createClient({ chain: studionet, account: B }),
  cc = createClient({ chain: studionet, account: C }), cs = createClient({ chain: studionet, account: S }), rd = createClient({ chain: studionet });
if (!st.funded) { for (const x of [A, B, C, S]) await rpc("sim_fundAccount", { account_address: x.address, amount: 400e18 }); st.funded = true; save(); }
console.log(`[${stamp()}] opener A ${A.address}\n           voter  B ${B.address}\n           voter  C ${C.address}\n           stranger ${S.address}\n           state ${STATE}`);

const balance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]) || "0x0");
const moved = async (a, before) => { for (let i = 0; i < 25; i++) { const b = await balance(a); if (b !== before) return b; await sleep(4000); } return await balance(a); };
const wait = async (tx) => { for (let i = 0; i < 120; i++) { await sleep(4000); const t = await rpc("eth_getTransactionByHash", [tx]); if (t?.status === "FINALIZED") { const lr = t.consensus_data?.leader_receipt, one = Array.isArray(lr) ? lr[0] : lr; let msg = ""; try { msg = Buffer.from(one.result, "base64").toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim(); } catch (e) {} let a = 0, d = 0, idl = 0; for (const k in (t.consensus_data?.votes || {})) { const v = t.consensus_data.votes[k]; if (v === "agree") a++; else if (v === "disagree") d++; else idl++; } const votes = { agree: a, disagree: d, idle: idl }; const applied = a * 2 > a + d + idl; let j = null; const b = msg.indexOf("{"); if (b !== -1) { try { j = JSON.parse(msg.slice(b)); } catch (e) {} } return { tx, msg, j, exec: one?.execution_result, votes, applied }; } if (t?.status === "CANCELED") return { tx, msg: "CANCELED", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false }; } return { tx, msg: "TIMEOUT", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false }; };
const deploy = async (client, path, args) => {
  const code = readFileSync(new URL(path, import.meta.url));
  const dh = await client.deployContract({ code, args, leaderOnly: false });
  console.log(`      deploy ${path.split("/").pop()}  ${dh}`);
  return (await client.waitForTransactionReceipt({ hash: dh, status: "ACCEPTED", retries: 60, interval: 4000 }))?.data?.contract_address;
};
const at = (addr) => async (client, fn, args = [], value) => {
  const r = await wait(await client.writeContract({ address: addr, functionName: fn, args, ...(value ? { value } : {}) }));
  console.log(`      [${stamp()}] ${fn}(${args.map((x) => String(x).slice(0, 14)).join(", ")})  ${r.tx}  ${tally(r)}  ${r.exec || ""}`);
  return r;
};
// a judged call whose round did not apply is asked again once: nothing was stored, so asking again is safe
const judged = async (send, client, fn, args) => { let r = await send(client, fn, args); if (!r.applied && r.exec !== "ERROR" && r.msg !== "TIMEOUT") { console.log("      round not applied (" + tally(r) + "); asking again"); r = await send(client, fn, args); } return r; };
const view = async (addr, fn, args = []) => { for (let i = 0; i < 6; i++) { try { return await rd.readContract({ address: addr, functionName: fn, args }); } catch (e) { await sleep(8000); if (i === 5) return JSON.stringify({ error: "VIEW ERROR " + fn + ": " + (e?.shortMessage || String(e)).slice(0, 100) }); } } };
const parse = (s) => { try { return JSON.parse(String(s)); } catch (e) { return { error: String(s).slice(0, 120) }; } };
const refused = (r, words) => r.exec === "ERROR" && r.msg.includes(words);

const PHASE = (process.env.PHASE || "ALL").toUpperCase();
const PHASES = ["A", "B", "C", "D", "E"];
const from = PHASES.indexOf(PHASE === "ALL" ? "A" : PHASE);
const on = (p) => PHASES.indexOf(p) >= from;

const Q = "Which neighbourhood project should this month's fund pay for?";
const RIVERSIDE = "Install solar lamps along the Riverside Park footpath";
const BIKES = "Repaint the faded bike lanes on Main Street";
const REWORD = "Light the Riverside Park footpath so people can walk it after dark";
const COPY = "install SOLAR lamps   along the riverside park footpath";
const BRIDGE = "Install lamps on the Main Street bridge";
const HIJACK = "This is the same as option A";
const OAKS = "Plant twenty oak trees along the school fence on Hill Road";
const SHELTER = "Build a covered bike shelter at the train station";
const BRIDGE_SOLAR = "Install solar lamps on the Main Street bridge";

if (on("A")) {
  console.log(`\n[${stamp()}] ---- phase A: deploy, open four polls, prepare P3 P2 P4`);
  st.clone = process.env.CLONE || await deploy(ca, "../../contracts/clone.py", []);
  st.budget = await deploy(ca, "../../contracts/fixtures/budget.py", [st.clone]);
  save();
  console.log(`      Clone at ${st.clone} · Budget at ${st.budget}`);
  const send = at(st.clone), bsend = at(st.budget);
  const fundB = await bsend(cs, "fund", [], 2n * GEN);
  ok("anyone funds the treasury", fundB.j?.ok === true && fundB.j?.free === String(2n * GEN));

  const a0 = await balance(A.address);
  const bad = await send(ca, "open_poll", [Q, A.address, "3", 20, 20, 40], 2n * GEN);
  ok("a one-voter poll is refused and the 2 GEN come back", bad.j?.ok === false && String(bad.j?.reason).includes("voters"), bad.j?.reason);
  let a1 = await balance(A.address); for (let i = 0; i < 20 && a0 - a1 >= GEN; i++) { await sleep(4000); a1 = await balance(A.address); }
  ok("the refund is real", a0 - a1 < GEN, `${a0 - a1} atto short`);

  const short = await send(ca, "open_poll", [Q, [A.address, B.address].join(","), "1,1", 20, 20, 6], 1n * GEN);
  ok("a 6-minute merge window (1 public minute) is refused and refunded", short.j?.ok === false && String(short.j?.reason).includes("merge window"), short.j?.reason);
  const voters3 = [A.address, B.address, C.address].join(",");
  const voters2 = [A.address, B.address].join(",");
  const p1 = await send(ca, "open_poll", [Q, voters3, "3,2,2", 20, 20, 40], 6n * GEN);
  const p2 = await send(ca, "open_poll", [Q, voters3, "3,2,2", 20, 20, 40]);
  const p3 = await send(ca, "open_poll", [Q, voters2, "1,1", 20, 20, 35], 1n * GEN);
  const p4 = await send(ca, "open_poll", [Q, voters2, "1,1", 10, 20, 35], 1n * GEN);
  st.P1 = p1.j?.poll; st.P2 = p2.j?.poll; st.P3 = p3.j?.poll; st.P4 = p4.j?.poll; save();
  ok("four polls opened with contract-assigned ids", [st.P1, st.P2, st.P3, st.P4].join() === "P1,P2,P3,P4", [st.P1, st.P2, st.P3, st.P4].join());
  await send(ca, "propose", [st.P4, OAKS, A.address]);

  // P3 first, so its 35-minute merge window runs while P1 and P2 are worked through
  await send(ca, "propose", [st.P3, OAKS, A.address]);
  await send(cb, "propose", [st.P3, SHELTER, B.address]);
  await send(ca, "close_proposals", [st.P3]);
  await send(ca, "vote", [st.P3, "O1"]); await send(cb, "vote", [st.P3, "O2"]);
  const cv3 = await send(ca, "close_votes", [st.P3]);
  ok("P3's votes are closed; its 35-minute merge window starts", cv3.j?.status === "closed");
  st.p3closed = Date.now(); save();

  // P2: the near-miss and the letter hijack
  const q1 = await send(cb, "propose", [st.P2, RIVERSIDE, B.address]);
  const q2 = await send(ca, "propose", [st.P2, BRIDGE, A.address]);
  const q3 = await send(cc, "propose", [st.P2, HIJACK, C.address]);
  ok("P2 holds O1 Riverside, O2 bridge, O3 the letter hijack", [q1, q2, q3].map((r) => r.j?.option).join() === "O1,O2,O3");
  await send(ca, "close_proposals", [st.P2]);
  await send(ca, "vote", [st.P2, "O2"]); await send(cb, "vote", [st.P2, "O1"]); await send(cc, "vote", [st.P2, "O3"]);
  const cv2 = await send(ca, "close_votes", [st.P2]);
  ok("P2's votes are closed by the opener", cv2.j?.status === "closed");
  st.p2closed = Date.now(); save();
}

if (on("B")) {
  console.log(`\n[${stamp()}] ---- phase B: P1, the reworded copy`);
  const send = at(st.clone), bsend = at(st.budget);
  // a continued run reads what is already on chain and skips it
  const was = PHASE === "B" ? parse(await view(st.clone, "poll", [st.P1])) : { status: "proposing", voted: [] };
  const voted = (x) => (was.voted || []).includes(x.address.toLowerCase());
  if (was.status === "proposing") {
  const stranger = await send(cs, "propose", [st.P1, RIVERSIDE, S.address]);
  ok("a stranger cannot propose", refused(stranger, "only the voters"), stranger.msg.slice(0, 70));
  const o1 = await send(cb, "propose", [st.P1, RIVERSIDE, B.address]);
  const o2 = await send(ca, "propose", [st.P1, BIKES, A.address]);
  ok("B proposes O1 (Riverside), A proposes O2 (bike lanes)", o1.j?.option === "O1" && o2.j?.option === "O2");
  const copy = await send(cc, "propose", [st.P1, COPY, C.address]);
  ok("C's exact copy of O1 in other case and spacing is refused by digest, stored, ok:false", copy.exec !== "ERROR" && copy.j?.ok === false && copy.j?.duplicate_of === "O1" && copy.j?.recorded === true, copy.j?.reason);
  const twice = await send(ca, "propose", [st.P1, BRIDGE, A.address]);
  ok("a voter proposes once", refused(twice, "one option"), twice.msg.slice(0, 70));
  const early = await send(cb, "close_proposals", [st.P1]);
  ok("a voter who is not the opener cannot close proposals early", refused(early, "only the opener"), early.msg.slice(0, 70));
  const o3 = await send(cc, "propose", [st.P1, REWORD, C.address]);
  ok("C proposes O3, a reworded copy of O1", o3.j?.option === "O3");
  const cp = await send(ca, "close_proposals", [st.P1]);
  ok("the opener closes proposals once every voter proposed", cp.j?.status === "voting");
  const sv = await send(cs, "vote", [st.P1, "O1"]);
  ok("a stranger cannot vote", refused(sv, "only the voters"));
  } else console.log("      continuing: P1 is " + was.status + ", voted " + JSON.stringify(was.voted));
  if (!voted(A)) await send(ca, "vote", [st.P1, "O2"]);
  if (!voted(B)) await send(cb, "vote", [st.P1, "O1"]);
  const again = await send(ca, "vote", [st.P1, "O1"]);
  ok("a voter votes once", refused(again, "once"));
  if (!voted(C)) await send(cc, "vote", [st.P1, "O3"]);
  const bcv = await send(cb, "close_votes", [st.P1]);
  ok("a voter who is not the opener cannot close the votes early", refused(bcv, "only the opener"));
  const cv = await send(ca, "close_votes", [st.P1]);
  ok("the opener closes the votes once every voter voted", cv.j?.status === "closed");
  const tEarly = await send(cs, "tally", [st.P1]);
  ok("no tally before a merge or the merge deadline", refused(tEarly, "nothing to tally yet"), tEarly.msg.slice(0, 70));
  const bm = await send(cb, "merge", [st.P1]);
  ok("inside the grace only the opener merges", refused(bm, "only the opener may merge"), bm.msg.slice(0, 80));
  const al = await bsend(ca, "allot", [st.P1, A.address, String(1n * GEN)]);
  ok("the treasury owner allots 1 GEN to P1, bound to the opener it knows", al.j?.ok === true);
  const bEarly = await bsend(cs, "pay", [st.P1]);
  ok("the fixture pays nothing before the tally", refused(bEarly, "not tallied"), bEarly.msg.slice(0, 70));
  const m = await judged(send, ca, "merge", [st.P1]);
  st.m1 = { tx: m.tx, votes: m.votes, p: m.j?.p, second: m.j?.second_order }; save();
  ok("the validators agree on P1's partition", m.applied && m.j?.ok === true, `${tally(m)} -> p=${m.j?.p} ${JSON.stringify(m.j?.classes)}`);
  ok("O3 is merged with O1 and O2 stays apart: p = 1,2,1", m.j?.p === "1,2,1");
  const m2 = await send(ca, "merge", [st.P1]);
  ok("a merge is final", refused(m2, "already final"));
  const pw = parse(await view(st.clone, "plurality_winner", [st.P1]));
  ok("plurality_winner reads O2 with weight 3", pw.option === "O2" && pw.weight === 3, JSON.stringify(pw));
  const b0 = await balance(B.address), c0 = await balance(C.address);
  const t = await send(cs, "tally", [st.P1]);
  st.t1 = { tx: t.tx, j: t.j }; save();
  ok("tally executes O1: class O1+O3 weight 4 beats O2 weight 3", t.j?.winner === "O1" && t.j?.class_weight === 4 && t.j?.plurality_winner === "O2", t.j?.why);
  ok("the pot is divided by direct votes: O1 2 and O3 2, 3 GEN each", JSON.stringify((t.j?.shares || []).map((x) => [x.option, x.weight, x.amount])) === JSON.stringify([["O1", 2, String(3n * GEN)], ["O3", 2, String(3n * GEN)]]), JSON.stringify(t.j?.shares));
  ok("3 GEN reach B, the payee of O1", (await moved(B.address, b0)) - b0 === 3n * GEN);
  ok("3 GEN reach C, the payee of O3", (await moved(C.address, c0)) - c0 === 3n * GEN);
  const b1 = await balance(B.address), c1 = await balance(C.address);
  const pay = await bsend(cs, "pay", [st.P1]);
  ok("the fixture divides its 1 GEN by the same rule, to B and C", pay.j?.ok === true && (pay.j?.to || []).map((x) => x[0]).join() === [B.address, C.address].join().toLowerCase(), JSON.stringify(pay.j));
  ok("and B and C have half a GEN each", (await moved(B.address, b1)) - b1 === GEN / 2n && (await moved(C.address, c1)) - c1 === GEN / 2n);
  const res = parse(await view(st.clone, "result", [st.P1]));
  ok("result(P1) publishes the winner beside plurality_winner", res.final === true && res.winner === "O1" && res.plurality_winner === "O2", res.why);
  const part = parse(await view(st.clone, "partition", [st.P1]));
  ok("partition(P1) is the reusable answer", part.p === "1,2,1" && part.source === "agreed", JSON.stringify(part.classes));
  const refs = parse(await view(st.clone, "refusals", [st.P1]));
  ok("the digest refusal is on the record", Array.isArray(refs) && refs.length === 1 && refs[0].duplicate_of === "O1");
}

if (on("C")) {
  console.log(`\n[${stamp()}] ---- phase C: P2, the near-miss and the letter hijack`);
  const send = at(st.clone), bsend = at(st.budget);
  const graceEnds = (st.p2closed || 0) + 5.5 * 60 * 1000;
  if (Date.now() < graceEnds) { console.log(`      waiting ${Math.ceil((graceEnds - Date.now()) / 1000)} s for P2's grace`); await sleep(graceEnds - Date.now()); }
  const m = await judged(send, cb, "merge", [st.P2]);
  st.m2 = { tx: m.tx, votes: m.votes, p: m.j?.p, second: m.j?.second_order }; save();
  ok("after the grace a voter merges P2 and the validators agree", m.applied && m.j?.ok === true, `${tally(m)} -> p=${m.j?.p}`);
  ok("the bridge lamps stay apart from the Riverside lamps, and the hijack is alone: p = 1,2,3", m.j?.p === "1,2,3");
  const t = await send(cs, "tally", [st.P2]);
  ok("with nothing merged the result is the plurality winner O2", t.j?.winner === "O2" && t.j?.plurality_winner === "O2", t.j?.why);
  const al = await bsend(ca, "allot", [st.P2, B.address, String(1n * GEN)]);
  ok("an allotment bound to the wrong opener is accepted by the owner", al.j?.ok === true);
  const pay = await bsend(cs, "pay", [st.P2]);
  ok("and the fixture refuses it and returns the amount: P2 was opened by somebody else", pay.j?.ok === false && String(pay.j?.reason).includes("not the opener"), pay.j?.reason);
  const tr = parse(await view(st.budget, "treasury"));
  ok("the treasury holds its free 1 GEN again", tr.free === String(1n * GEN), tr.free);
  const al2 = await bsend(ca, "allot", [st.P2, A.address, String(1n * GEN)]);
  ok("the refused allotment can be made again with the right opener", al2.j?.ok === true, JSON.stringify(al2.j));
}

if (on("D")) {
  console.log(`\n[${stamp()}] ---- phase D: P3 the fallback, P4 void`);
  const send = at(st.clone);
  const deadline = (st.p3closed || 0) + 35.5 * 60 * 1000;
  if (Date.now() < deadline) { console.log(`      waiting ${Math.ceil((deadline - Date.now()) / 1000)} s for P3's merge deadline`); await sleep(deadline - Date.now()); }
  const late = await send(ca, "merge", [st.P3]);
  ok("nobody merges after the merge deadline, not even the opener", refused(late, "merge window"), late.msg.slice(0, 80));
  const a0 = await balance(A.address);
  const t = await send(cs, "tally", [st.P3]);
  ok("the tally falls back to plain plurality, stored as the value", t.j?.source === "fallback" && t.j?.partition === "1,2" && t.j?.winner === "O1", t.j?.why);
  ok("the 1 GEN pot reaches A, the payee of O1 (a 1-1 tie goes to the lower id)", (await moved(A.address, a0)) - a0 === 1n * GEN);
  const a1 = await balance(A.address);
  const v = await send(cs, "close_proposals", [st.P4]);
  ok("after its window anyone closes P4; one option makes it void", v.j?.status === "void", JSON.stringify(v.j));
  ok("and its 1 GEN goes back to the opener", (await moved(A.address, a1)) - a1 === 1n * GEN);
  const rule = parse(await view(st.clone, "agreement_rule"));
  ok("the agreement rule is published by the contract", String(rule.compared).includes("exact string equality"));
}

if (on("E")) {
  console.log(`\n[${stamp()}] ---- phase E: a cancelled allotment; more specific and somewhere else`);
  const send = at(st.clone), bsend = at(st.budget);
  const f = await bsend(cs, "fund", [], GEN / 2n);
  const al7 = await bsend(ca, "allot", ["P77", A.address, String(GEN / 2n)]);
  const cn = await bsend(ca, "cancel", ["P77"]);
  ok("an allotment for a poll the register does not have is cancelled by the owner", f.j?.ok === true && al7.j?.ok === true && cn.j?.state === "cancelled", JSON.stringify(cn.j));
  const p5 = await send(ca, "open_poll", [Q, [A.address, B.address].join(","), "1,1", 20, 20, 40]);
  st.P5 = p5.j?.poll; save();
  const s1 = await send(ca, "propose", [st.P5, BRIDGE_SOLAR, A.address]);
  const s2 = await send(cb, "propose", [st.P5, REWORD, B.address]);
  ok("the pair is on the ballot", s1.j?.option === "O1" && s2.j?.option === "O2", `${st.P5} ${s1.msg.slice(0, 60)} ${s2.msg.slice(0, 60)}`);
  await send(ca, "close_proposals", [st.P5]);
  await send(ca, "vote", [st.P5, "O1"]); await send(cb, "vote", [st.P5, "O2"]);
  await send(ca, "close_votes", [st.P5]);
  const m5 = await judged(send, ca, "merge", [st.P5]);
  st.m5 = { tx: m5.tx, votes: m5.votes, p: m5.j?.p, second: m5.j?.second_order }; save();
  ok("the validators agree on the partition", m5.applied && m5.j?.ok === true, `${tally(m5)} -> p=${m5.j?.p}`);
  ok("solar lamps on the bridge stay apart from lighting the Riverside footpath: p = 1,2", m5.j?.p === "1,2");
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("Clone:", st.clone, "· Budget:", st.budget);
if (st.m1) console.log("P1 merge", st.m1.tx, JSON.stringify(st.m1.votes), st.m1.p);
if (st.m2) console.log("P2 merge", st.m2.tx, JSON.stringify(st.m2.votes), st.m2.p);
if (st.m5) console.log(st.P5 + " merge", st.m5.tx, JSON.stringify(st.m5.votes), st.m5.p);
