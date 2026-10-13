// RenewWise money rules. Everything that touches a price, a date, a refund or a confirmation is decided here,
// in plain code, so a model can talk about a change but can never invent its amount or skip a confirmation.
import {
  ActionKind, CallContext, HouseholdState, LedgerEntry, Member, Plan, Proposal, Reminder, RuleError, Subscription, Vote,
} from "./types";
import { cleanSpeech, daysBetween, listWords, relativeDay, screenMoney, shortDate, spokenDate, spokenMoney } from "./speech";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const HEAVY_USE_HOURS_30D = 8;
export const BRIEFING_WINDOW_DAYS = 7;

/** An Echo Show style card: one title, at most two fields, at most one action. */
export interface Card {
  kind: "briefing" | "usage" | "votes" | "confirm" | "receipt" | "reminder" | "memory" | "blocked";
  title: string;
  fields: { label: string; value: string }[];
  /** What a tap does: say the utterance, or (for confirm/undo) call the MCP tool directly as the person who tapped. */
  action?: { label: string; utterance: string; tool?: { name: string; arguments: Record<string, unknown> } };
  tone?: "neutral" | "good" | "warn";
  footnote?: string;
}

// ---------- small helpers ----------

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const d = new Date(date + "T12:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function nextId(state: HouseholdState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function getSub(state: HouseholdState, id: string): Subscription {
  const key = id.trim().toLowerCase();
  const sub = state.subscriptions.find((s) => s.id === key || s.name.toLowerCase() === key || s.name.toLowerCase().startsWith(key));
  if (!sub) {
    throw new RuleError("unknown_subscription", `No subscription called ${id}. This household has ${listWords(state.subscriptions.map((s) => s.name))}.`);
  }
  return sub;
}

export function getMember(state: HouseholdState, id: string | null | undefined): Member | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  return state.members.find((m) => m.id === key || m.name.toLowerCase() === key) ?? null;
}

export function currentPlan(sub: Subscription): Plan {
  return sub.plans.find((p) => p.id === sub.planId)!;
}

export function monthlyCents(plan: Plan): number {
  return plan.period === "year" ? Math.round(plan.priceCents / 12) : plan.priceCents;
}

function priceText(plan: Plan): string {
  return `${screenMoney(plan.priceCents)}/${plan.period === "year" ? "yr" : "mo"}`;
}

function spokenPrice(plan: Plan): string {
  return `${spokenMoney(plan.priceCents)} a ${plan.period}`;
}

function memberName(state: HouseholdState, id: string): string {
  return getMember(state, id)?.name ?? id;
}

function approvers(state: HouseholdState): string {
  return listWords(state.members.filter((m) => m.billingAuthority).map((m) => m.name)).replace(" and ", " or ");
}

// ---------- usage and refund facts ----------

export function usageFacts(state: HouseholdState, sub: Subscription) {
  const plan = currentPlan(sub);
  const hours = sub.usage.reduce((a, u) => a + u.hours30d, 0);
  const heavy = sub.usage.filter((u) => u.hours30d >= HEAVY_USE_HOURS_30D).map((u) => u.memberId);
  const active30 = sub.usage.filter((u) => u.sessions30d > 0).map((u) => u.memberId);
  const lastUsed = sub.usage.map((u) => u.lastUsed).filter(Boolean).sort().pop() ?? null;
  const daysSinceUse = lastUsed ? daysBetween(lastUsed, state.today) : null;
  const costPerHourCents = hours > 0 ? Math.round(monthlyCents(plan) / hours) : null;
  return { hours30d: Math.round(hours * 10) / 10, heavyUsers: heavy, activeUsers30d: active30, lastUsed, daysSinceUse, costPerHourCents };
}

export function refundEligibility(state: HouseholdState, sub: Subscription) {
  const p = sub.policy;
  if (!sub.lastCharge || p.refundWindowDays <= 0) {
    return { eligible: false, amountCents: 0, reason: `${sub.name} does not offer refunds; cancelling stops the next charge instead.` };
  }
  if (sub.status === "refunded") return { eligible: false, amountCents: 0, reason: "The latest charge was already refunded." };
  const age = daysBetween(sub.lastCharge.date, state.today);
  const windowEnds = addDays(sub.lastCharge.date, p.refundWindowDays);
  if (age > p.refundWindowDays) {
    return { eligible: false, amountCents: 0, windowEnds, reason: `The refund window closed on ${spokenDate(windowEnds)}.` };
  }
  if (sub.sessionsSinceLastCharge > p.refundMaxSessionsSinceCharge) {
    return { eligible: false, amountCents: 0, windowEnds, reason: `It was used ${sub.sessionsSinceLastCharge} times since the charge, and the policy allows at most ${p.refundMaxSessionsSinceCharge}.` };
  }
  // The refund amount always comes from the charge on file, never from a request.
  return { eligible: true, amountCents: sub.lastCharge.amountCents, windowEnds, reason: `Charged ${relativeDay(state.today, sub.lastCharge.date)}, used ${sub.sessionsSinceLastCharge} times since, refund window open until ${spokenDate(windowEnds)}.` };
}

/** Code-computed suggestion. The model explains it; it does not invent it. */
export function suggest(state: HouseholdState, sub: Subscription) {
  const f = usageFacts(state, sub);
  const plan = currentPlan(sub);
  const refund = refundEligibility(state, sub);
  const cheaper = sub.plans
    .filter((p) => monthlyCents(p) < monthlyCents(plan) && (p.maxMembers ?? 99) >= Math.max(1, f.activeUsers30d.length))
    .sort((a, b) => monthlyCents(a) - monthlyCents(b))[0];
  if (sub.status !== "active") return { action: "none" as const, why: `Already ${sub.status.replace("_", " ")}.` };
  if (refund.eligible && f.hours30d === 0) return { action: "refund_and_cancel" as const, why: `Nobody used it in 30 days and the charge is still refundable. ${refund.reason}` };
  if (f.activeUsers30d.length === 0) {
    return sub.policy.pauseMonths.length
      ? { action: "cancel" as const, why: `Nobody used it in ${f.daysSinceUse ?? "over 60"} days. Pausing is also offered.`, alt: "pause" }
      : { action: "cancel" as const, why: `Nobody used it in ${f.daysSinceUse ?? "over 60"} days.` };
  }
  if (f.heavyUsers.length === 1 && f.activeUsers30d.length <= 2 && cheaper) {
    return { action: "downgrade" as const, toPlanId: cheaper.id, why: `Mostly one person uses it (${memberName(state, f.heavyUsers[0])}). ${cheaper.name} keeps access for ${screenMoney(monthlyCents(plan) - monthlyCents(cheaper))} less a month.` };
  }
  return { action: "keep" as const, why: `${f.activeUsers30d.length} people used it for ${f.hours30d} hours this month.` };
}

// ---------- briefing ----------

export function refreshDue(state: HouseholdState) {
  for (const r of state.reminders) if (r.status === "scheduled" && r.dueDate <= state.today) r.status = "due";
}

export function briefing(state: HouseholdState, withinDays = BRIEFING_WINDOW_DAYS) {
  refreshDue(state);
  const horizon = addDays(state.today, withinDays);
  const renewals = state.subscriptions
    .filter((s) => (s.status === "active" || s.status === "cancel_pending") && s.nextRenewal <= horizon && s.nextRenewal >= state.today)
    .sort((a, b) => a.nextRenewal.localeCompare(b.nextRenewal))
    .map((s) => {
      const plan = currentPlan(s);
      const f = usageFacts(state, s);
      return {
        subscriptionId: s.id, name: s.name, plan: plan.name, price: priceText(plan), renews: s.nextRenewal,
        renewsIn: relativeDay(state.today, s.nextRenewal), status: s.status, scheduledChange: s.scheduled ?? null,
        hoursLast30Days: f.hours30d, usedBy: f.activeUsers30d.map((id) => memberName(state, id)), suggestion: suggest(state, s),
      };
    });
  const refundable = state.subscriptions
    .filter((s) => refundEligibility(state, s).eligible)
    .map((s) => ({ subscriptionId: s.id, name: s.name, charged: s.lastCharge, refund: refundEligibility(state, s), suggestion: suggest(state, s) }));
  const dueReminders = state.reminders.filter((r) => r.status === "due").map((r) => ({ ...r, subscription: getSub(state, r.subscriptionId).name }));
  const monthlyAtStake = renewals.filter((r) => r.status === "active" && r.suggestion.action !== "keep")
    .reduce((a, r) => a + monthlyCents(currentPlan(getSub(state, r.subscriptionId))), 0);

  const parts: string[] = [];
  for (const r of dueReminders) parts.push(`You asked me to bring up ${r.subscription} today: ${r.note}`);
  for (const r of renewals.filter((x) => x.status === "active")) parts.push(`${r.name} renews ${r.renewsIn} for ${spokenPrice(currentPlan(getSub(state, r.subscriptionId)))}`);
  for (const r of refundable) parts.push(`${r.name} charged ${spokenMoney(r.charged!.amountCents)} ${relativeDay(state.today, r.charged!.date)} and can still be refunded`);
  const speech = parts.length ? cleanSpeech(parts.join(". ") + ".") : "Nothing renews in the next week.";

  const card: Card = {
    kind: "briefing",
    title: renewals.length + refundable.length + dueReminders.length ? `${renewals.length + refundable.length + dueReminders.length} things to decide this week` : "Nothing to decide this week",
    fields: [
      { label: "Renewing soon", value: renewals.map((r) => `${r.name} ${shortDate(r.renews)}`).join(", ") || "None" },
      { label: "Could save", value: monthlyAtStake ? `${screenMoney(monthlyAtStake)}/mo` : "Nothing yet" },
    ],
    action: renewals[0] ? { label: `Start with ${renewals[0].name}`, utterance: `Let's talk about ${renewals[0].name}.` } : undefined,
    tone: "neutral",
  };
  return { today: state.today, renewals, refundable, dueReminders, speech, card };
}

// ---------- votes and the household resolution policy ----------

export function recordVote(state: HouseholdState, ctx: CallContext, subId: string, preference: Vote["preference"], reason: string) {
  const sub = getSub(state, subId);
  const voter = getMember(state, ctx.speakerId);
  if (!voter) throw new RuleError("unknown_speaker", "I need to know who is speaking before I record an opinion. Each person records their own.");
  const list = (state.votes[sub.id] ??= []);
  const i = list.findIndex((v) => v.memberId === voter.id);
  const vote: Vote = { memberId: voter.id, preference, reason: reason.slice(0, 200), at: state.today };
  if (i >= 0) list[i] = vote; else list.push(vote);
  state.memory.push({ id: nextId(state, "m"), date: state.today, subscriptionId: sub.id, memberId: voter.id, kind: "vote", text: `${voter.name} wants to ${preference} ${sub.name}: ${vote.reason}` });
  return { recorded: vote, ...resolve(state, sub.id) };
}

export function resolve(state: HouseholdState, subId: string) {
  const sub = getSub(state, subId);
  const votes = state.votes[sub.id] ?? [];
  const byRole = (adult: boolean) => votes.filter((v) => (getMember(state, v.memberId)?.billingAuthority ?? false) === adult);
  const adultVotes = byRole(true);
  const positions = votes.map((v) => ({ member: memberName(state, v.memberId), preference: v.preference, reason: v.reason }));
  const f = usageFacts(state, sub);
  const plan = currentPlan(sub);

  type R = { status: string; recommended: ActionKind | null; toPlanId?: string; pauseMonths?: number; reminder?: { eventId?: string; dueDate: string; note: string }; explanation: string };
  let r: R;
  if (!votes.length) r = { status: "no_votes", recommended: null, explanation: "Nobody has said what they want yet." };
  else if (!adultVotes.length) r = { status: "needs_adult", recommended: null, explanation: `Only ${listWords(positions.map((p) => p.member))} has weighed in. ${approvers(state)} decides on billing.` };
  else if (new Set(adultVotes.map((v) => v.preference)).size > 1) r = { status: "adults_disagree", recommended: null, explanation: `${listWords(adultVotes.map((v) => `${memberName(state, v.memberId)} wants to ${v.preference}`))}. Nothing changes until the adults agree.` };
  else {
    const adultPref = adultVotes[0].preference;
    // Policy: the payer decides, but cutting off someone who uses it a lot triggers a counter offer.
    const protectedUsers = votes.filter((v) => v.preference === "keep" && f.heavyUsers.includes(v.memberId) && !getMember(state, v.memberId)?.billingAuthority);
    if (adultPref !== "keep" && protectedUsers.length) {
      const who = memberName(state, protectedUsers[0].memberId);
      const event = sub.events.find((e) => e.memberId === protectedUsers[0].memberId && e.date >= state.today);
      const cheapest = sub.plans.filter((p) => monthlyCents(p) < monthlyCents(plan)).sort((a, b) => monthlyCents(a) - monthlyCents(b))[0];
      const reminder = event ? { eventId: event.id, dueDate: addDays(event.date, 1), note: `${event.title} has aired. Decide whether to keep ${sub.name}.` } : undefined;
      if (cheapest) {
        r = { status: "compromise", recommended: "downgrade", toPlanId: cheapest.id, reminder,
          explanation: `${who} uses ${sub.name} a lot, so instead of cancelling: switch to ${cheapest.name} for ${screenMoney(monthlyCents(plan) - monthlyCents(cheapest))} less a month${event ? `, and revisit after ${event.title} on ${shortDate(event.date)}` : ""}.` };
      } else if (sub.policy.pauseMonths.length) {
        r = { status: "compromise", recommended: "pause", pauseMonths: sub.policy.pauseMonths[0], reminder, explanation: `${who} uses it a lot, so pause for ${sub.policy.pauseMonths[0]} month instead of cancelling.` };
      } else {
        r = { status: "compromise", recommended: "keep", reminder, explanation: `${who} uses it a lot and there is no cheaper plan. Keep it this month and revisit${event ? ` after ${event.title}` : ""}.` };
      }
    } else {
      r = { status: "agreed", recommended: adultPref === "keep" ? "keep" : adultPref === "downgrade" ? "downgrade" : adultPref,
        toPlanId: adultPref === "downgrade" ? suggestCheaper(sub, f.activeUsers30d.length)?.id : undefined,
        pauseMonths: adultPref === "pause" ? sub.policy.pauseMonths[0] : undefined,
        explanation: `${listWords(adultVotes.map((v) => memberName(state, v.memberId)))} decided to ${adultPref}.` };
      if (adultPref === "pause" && !sub.policy.pauseMonths.length) {
        r = { status: "agreed_but_not_offered", recommended: null, explanation: `${sub.name} does not offer pausing. The options are cancel${sub.plans.length > 1 ? " or a cheaper plan" : ""}.` };
      }
    }
  }
  const card: Card = {
    kind: "votes",
    title: `${sub.name}: ${r.status === "compromise" ? "a middle ground" : r.status === "agreed" ? "the family agrees" : "still deciding"}`,
    fields: [
      { label: "Who wants what", value: positions.map((p) => `${p.member}: ${p.preference}`).join(", ") || "No one yet" },
      { label: "Suggested", value: r.recommended ? describeAction(sub, r.recommended, r.toPlanId, r.pauseMonths) : "Wait for an adult" },
    ],
    action: r.recommended && r.recommended !== "keep" ? { label: "Set it up", utterance: `Okay, let's ${describeAction(sub, r.recommended, r.toPlanId, r.pauseMonths).toLowerCase()}.` } : undefined,
    tone: r.status === "compromise" || r.status === "agreed" ? "good" : "neutral",
  };
  return { positions, resolution: r, card, speech: cleanSpeech(r.explanation) };
}

function suggestCheaper(sub: Subscription, activeUsers: number) {
  const plan = currentPlan(sub);
  return sub.plans.filter((p) => monthlyCents(p) < monthlyCents(plan) && (p.maxMembers ?? 99) >= Math.max(1, activeUsers))
    .sort((a, b) => monthlyCents(b) - monthlyCents(a))[0];
}

export function describeAction(sub: Subscription, kind: ActionKind, toPlanId?: string, pauseMonths?: number): string {
  const to = sub.plans.find((p) => p.id === toPlanId);
  switch (kind) {
    case "cancel": return `Cancel ${sub.name}`;
    case "pause": return `Pause ${sub.name} for ${pauseMonths ?? 1} month${(pauseMonths ?? 1) > 1 ? "s" : ""}`;
    case "downgrade": case "switch_plan": return `Switch ${sub.name} to ${to?.name ?? "a cheaper plan"}`;
    case "refund_and_cancel": return `Refund and cancel ${sub.name}`;
    case "keep": return `Keep ${sub.name}`;
  }
}

// ---------- proposals (step 1 of 2) ----------

export interface ProposeInput { subscriptionId: string; action: Exclude<ActionKind, "keep">; toPlanId?: string; pauseMonths?: number }

export function propose(state: HouseholdState, ctx: CallContext, input: ProposeInput) {
  const sub = getSub(state, input.subscriptionId);
  const plan = currentPlan(sub);
  if (sub.scheduled) {
    throw new RuleError("already_scheduled", `${sub.name} already has a change scheduled: ${sub.scheduled.kind} on ${spokenDate(sub.scheduled.effectiveDate)}. Undo it first to pick something else.`);
  }
  if (sub.status !== "active") throw new RuleError("not_active", `${sub.name} is ${sub.status.replace("_", " ")}, so there is nothing to change.`);

  let effectiveDate = sub.nextRenewal;
  let monthlyChange = 0;
  let refund = 0;
  let reversible = true;
  let toPlanId: string | undefined;
  let pauseMonths: number | undefined;
  let screen = "";
  let voice = "";

  switch (input.action) {
    case "cancel": {
      monthlyChange = -monthlyCents(plan);
      screen = `Access until ${shortDate(effectiveDate)}, then billing stops. Saves ${screenMoney(monthlyCents(plan))}/mo.`;
      voice = `cancel ${sub.name}. You keep it until ${spokenDate(effectiveDate)}, then the ${spokenPrice(plan)} stops. You can undo this until then`;
      break;
    }
    case "pause": {
      const allowed = sub.policy.pauseMonths;
      if (!allowed.length) throw new RuleError("pause_not_offered", `${sub.name} does not offer pausing. You can cancel${sub.plans.length > 1 ? " or switch to a cheaper plan" : ""} instead.`);
      pauseMonths = input.pauseMonths ?? allowed[0];
      if (!allowed.includes(pauseMonths)) throw new RuleError("pause_length_not_offered", `${sub.name} can pause for ${listWords(allowed.map(String))} months only.`);
      monthlyChange = -monthlyCents(plan);
      const resumes = addMonths(effectiveDate, pauseMonths);
      screen = `No charge from ${shortDate(effectiveDate)} until ${shortDate(resumes)}. Billing resumes after.`;
      voice = `pause ${sub.name} for ${pauseMonths} month${pauseMonths > 1 ? "s" : ""}. There is no charge from ${spokenDate(effectiveDate)}, and billing starts again on ${spokenDate(resumes)}. You can undo this until ${spokenDate(effectiveDate)}`;
      break;
    }
    case "downgrade":
    case "switch_plan": {
      const to = sub.plans.find((p) => p.id === input.toPlanId) ?? (input.action === "downgrade" ? suggestCheaper(sub, usageFacts(state, sub).activeUsers30d.length) : undefined);
      if (!to) throw new RuleError("unknown_plan", `${sub.name} plans are ${listWords(sub.plans.map((p) => `${p.name} (${p.id})`))}.`);
      if (to.id === plan.id) throw new RuleError("same_plan", `${sub.name} is already on ${plan.name}.`);
      if (input.action === "downgrade" && monthlyCents(to) >= monthlyCents(plan)) throw new RuleError("not_cheaper", `${to.name} is not cheaper than ${plan.name}.`);
      const users = usageFacts(state, sub).activeUsers30d.length;
      if (to.maxMembers && users > to.maxMembers) throw new RuleError("plan_too_small", `${to.name} allows ${to.maxMembers} people, but ${users} people used ${sub.name} this month.`);
      toPlanId = to.id;
      monthlyChange = monthlyCents(to) - monthlyCents(plan);
      screen = `${plan.name} ${priceText(plan)} to ${to.name} ${priceText(to)} from ${shortDate(effectiveDate)}.${to.note ? ` ${to.note}.` : ""}`;
      voice = `switch ${sub.name} from ${plan.name} to ${to.name}, ${spokenPrice(to)} instead of ${spokenPrice(plan)}, starting ${spokenDate(effectiveDate)}${to.note ? `. ${to.note}` : ""}. You can undo this until then`;
      break;
    }
    case "refund_and_cancel": {
      const e = refundEligibility(state, sub);
      if (!e.eligible) throw new RuleError("refund_not_eligible", e.reason);
      refund = e.amountCents;
      effectiveDate = state.today;
      reversible = false;
      monthlyChange = -monthlyCents(plan);
      screen = `Refund ${screenMoney(refund)} for the ${shortDate(sub.lastCharge!.date)} charge and end access today. Cannot be undone.`;
      voice = `refund the ${spokenMoney(refund)} ${sub.name} charge from ${spokenDate(sub.lastCharge!.date)} and end it today. This one cannot be undone`;
      break;
    }
    default:
      throw new RuleError("unknown_action", "Actions are cancel, pause, downgrade, switch_plan or refund_and_cancel.");
  }

  for (const p of state.proposals) if (p.subscriptionId === sub.id && p.status === "pending") p.status = "superseded";
  const proposal: Proposal = {
    id: nextId(state, "cf"), subscriptionId: sub.id, subscriptionVersion: sub.version, kind: input.action, toPlanId, pauseMonths,
    effectiveDate, monthlyChangeCents: monthlyChange, refundCents: refund, reversible,
    summary: screen, speech: cleanSpeech(`To confirm, ${voice}. ${approvers(state)}, say yes to confirm.`),
    createdTurn: ctx.turn, createdAtMs: ctx.nowMs, expiresAtMs: ctx.nowMs + CONFIRMATION_TTL_MS,
    proposedFor: ctx.speakerId, status: "pending",
  };
  state.proposals.push(proposal);
  if (state.proposals.length > 40) state.proposals.splice(0, state.proposals.length - 40);

  const card: Card = {
    kind: "confirm",
    title: describeAction(sub, input.action, toPlanId, pauseMonths) + "?",
    fields: [
      { label: refund ? "Refund now" : monthlyChange <= 0 ? "Saves" : "Costs", value: refund ? screenMoney(refund) : `${screenMoney(Math.abs(monthlyChange))}/mo` },
      { label: reversible ? "Takes effect" : "Final", value: reversible ? `${shortDate(effectiveDate)}, undo until then` : "Cannot be undone" },
    ],
    action: { label: "Confirm", utterance: "Yes, confirm.", tool: { name: "confirm_change", arguments: { confirmation_id: proposal.id } } },
    tone: reversible ? "neutral" : "warn",
    footnote: `Needs ${approvers(state)} to say yes.`,
  };
  return { confirmationId: proposal.id, proposal, card, speech: proposal.speech, needsApprovalFrom: state.members.filter((m) => m.billingAuthority).map((m) => m.name) };
}

// ---------- confirmation (step 2 of 2) ----------

export function confirm(state: HouseholdState, ctx: CallContext, confirmationId: string) {
  const p = state.proposals.find((x) => x.id === confirmationId);
  if (!p) throw new RuleError("unknown_confirmation", "That confirmation does not exist. Ask me to set the change up again.");
  if (p.status === "confirmed") {
    const done = state.ledger.find((l) => l.id === p.id)!;
    return { alreadyConfirmed: true, change: done, card: receiptCard(state, done), speech: "That change was already made. Nothing was charged twice." };
  }
  if (p.status === "superseded") throw new RuleError("superseded", "A newer proposal replaced that one. Please confirm the latest one.");
  if (p.status === "expired") throw new RuleError("expired", "That confirmation expired. Ask me to set it up again.");
  if (ctx.nowMs > p.expiresAtMs) { p.status = "expired"; throw new RuleError("expired", "That confirmation expired after 10 minutes. Ask me to set it up again."); }
  const speaker = getMember(state, ctx.speakerId);
  if (!speaker) throw new RuleError("unknown_speaker", `I could not tell who said yes. ${approvers(state)} needs to confirm.`);
  if (!speaker.billingAuthority) throw new RuleError("not_authorized", `${speaker.name} can't approve billing changes. ${approvers(state)} needs to say yes.`);
  if (ctx.turn <= p.createdTurn) throw new RuleError("needs_new_turn", "A person has to say yes after hearing the summary, in a new turn. I can't confirm on my own.");
  const sub = getSub(state, p.subscriptionId);
  if (sub.version !== p.subscriptionVersion) { p.status = "expired"; throw new RuleError("stale", `${sub.name} changed since this was proposed. Ask me to set it up again.`); }

  const before = { status: sub.status, planId: sub.planId, scheduled: sub.scheduled, pausedUntil: sub.pausedUntil };
  let amount = 0;
  switch (p.kind) {
    case "cancel": sub.status = "cancel_pending"; sub.scheduled = { changeId: p.id, kind: "cancel", effectiveDate: p.effectiveDate }; break;
    case "pause": sub.scheduled = { changeId: p.id, kind: "pause", effectiveDate: p.effectiveDate, pauseMonths: p.pauseMonths }; break;
    case "downgrade": case "switch_plan": sub.scheduled = { changeId: p.id, kind: p.kind, effectiveDate: p.effectiveDate, toPlanId: p.toPlanId }; break;
    case "refund_and_cancel": {
      // Re-check eligibility at execution time, and take the amount from the charge on file, not from the proposal.
      const e = refundEligibility(state, sub);
      if (!e.eligible || e.amountCents !== p.refundCents) { p.status = "expired"; throw new RuleError("refund_not_eligible", e.reason); }
      amount = e.amountCents; sub.status = "refunded"; break;
    }
  }
  sub.version += 1;
  p.status = "confirmed";
  const entry: LedgerEntry = {
    id: p.id, date: state.today, atMs: ctx.nowMs, subscriptionId: sub.id, kind: p.kind, confirmedBy: speaker.id, amountCents: amount,
    monthlyChangeCents: p.monthlyChangeCents, detail: p.summary, reversible: p.reversible, before,
  };
  state.ledger.push(entry);
  for (const r of state.reminders) if (r.subscriptionId === sub.id && r.status === "due") r.status = "done";
  state.memory.push({ id: nextId(state, "m"), date: state.today, subscriptionId: sub.id, memberId: speaker.id, kind: "decision", text: `${speaker.name} confirmed: ${describeAction(sub, p.kind, p.toPlanId, p.pauseMonths)}. ${p.summary}` });
  const speech = cleanSpeech(`Done. ${describeAction(sub, p.kind, p.toPlanId, p.pauseMonths)}${amount ? `. ${spokenMoney(amount)} goes back to the card on file` : ""}${p.reversible ? `. You can undo it until ${spokenDate(p.effectiveDate)}` : ""}.`);
  return { alreadyConfirmed: false, change: entry, card: receiptCard(state, entry), speech };
}

function receiptCard(state: HouseholdState, e: LedgerEntry): Card {
  const sub = getSub(state, e.subscriptionId);
  const p = state.proposals.find((x) => x.id === e.id);
  return {
    kind: "receipt",
    title: e.undone ? `Undone: ${sub.name}` : `Done: ${describeAction(sub, e.kind as ActionKind, p?.toPlanId, p?.pauseMonths)}`,
    fields: [
      { label: e.amountCents ? "Refunded" : "Monthly change", value: e.amountCents ? screenMoney(e.amountCents) : `${screenMoney(e.monthlyChangeCents)}/mo` },
      { label: "Confirmed by", value: memberName(state, String(e.confirmedBy)) },
    ],
    action: e.reversible && !e.undone ? { label: "Undo", utterance: `Undo the ${sub.name} change.`, tool: { name: "undo_change", arguments: { change: e.id } } } : undefined,
    tone: "good",
    footnote: `Change ${e.id}`,
  };
}

// ---------- undo ----------

export function undo(state: HouseholdState, ctx: CallContext, changeIdOrSub: string) {
  const entry = [...state.ledger].reverse().find((l) => l.id === changeIdOrSub && !l.undone)
    ?? [...state.ledger].reverse().find((l) => !l.undone && l.kind !== "undo" && l.kind !== "renewal_charge" && (() => { try { return getSub(state, changeIdOrSub).id === l.subscriptionId; } catch { return false; } })());
  if (!entry) throw new RuleError("nothing_to_undo", "I could not find a change to undo.");
  const speaker = getMember(state, ctx.speakerId);
  if (!speaker?.billingAuthority) throw new RuleError("not_authorized", `${speaker?.name ?? "That person"} can't change billing. ${approvers(state)} can undo it.`);
  if (!entry.reversible) throw new RuleError("not_reversible", "That change was final, so it can't be undone.");
  const sub = getSub(state, entry.subscriptionId);
  if (!sub.scheduled || sub.scheduled.changeId !== entry.id) throw new RuleError("already_effective", `That ${sub.name} change already took effect, so it can't be undone now.`);
  sub.status = entry.before!.status;
  sub.planId = entry.before!.planId;
  sub.scheduled = entry.before!.scheduled;
  sub.pausedUntil = entry.before!.pausedUntil;
  sub.version += 1;
  entry.undone = true;
  state.ledger.push({ id: nextId(state, "ch"), date: state.today, atMs: ctx.nowMs, subscriptionId: sub.id, kind: "undo", confirmedBy: speaker.id, amountCents: 0, monthlyChangeCents: -entry.monthlyChangeCents, detail: `Undid ${entry.id}`, reversible: false });
  state.memory.push({ id: nextId(state, "m"), date: state.today, subscriptionId: sub.id, memberId: speaker.id, kind: "decision", text: `${speaker.name} undid the ${sub.name} change; it stays as before.` });
  return { undone: entry.id, card: receiptCard(state, entry), speech: cleanSpeech(`Undone. ${sub.name} stays on ${currentPlan(sub).name}, ${spokenPrice(currentPlan(sub))}.`) };
}

// ---------- reminders ----------

export function scheduleReminder(state: HouseholdState, ctx: CallContext, subId: string, opts: { eventId?: string; date?: string; note: string }) {
  const sub = getSub(state, subId);
  let due = opts.date;
  let eventId: string | undefined;
  if (opts.eventId) {
    const ev = sub.events.find((e) => e.id === opts.eventId || e.title.toLowerCase().includes(opts.eventId!.toLowerCase()));
    if (!ev) throw new RuleError("unknown_event", `I don't know that event. Known events for ${sub.name}: ${listWords(sub.events.map((e) => `${e.title} (${e.id})`)) || "none"}.`);
    due = addDays(ev.date, 1);
    eventId = ev.id;
  }
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new RuleError("bad_date", "Give a date as YYYY-MM-DD or an event id.");
  if (due < state.today) throw new RuleError("past_date", "That date has already passed.");
  if (daysBetween(state.today, due) > 400) throw new RuleError("too_far", "Reminders can be at most about a year out.");
  const r: Reminder = { id: nextId(state, "r"), subscriptionId: sub.id, createdBy: ctx.speakerId ?? "assistant", dueDate: due, eventId, note: opts.note.slice(0, 200), status: "scheduled" };
  state.reminders.push(r);
  const pending = state.proposals.some((p) => p.subscriptionId === sub.id && p.status === "pending");
  const warning = sub.status === "active" && due > sub.nextRenewal && !sub.scheduled && !pending
    ? `Heads up: ${sub.name} renews on ${spokenDate(sub.nextRenewal)}, before this reminder.` : undefined;
  const card: Card = {
    kind: "reminder", title: `Reminder set: ${sub.name}`,
    fields: [{ label: "When", value: `${shortDate(due)}${eventId ? " (day after the finale)" : ""}` }, { label: "About", value: r.note }],
    tone: warning ? "warn" : "good", footnote: warning,
  };
  return { reminder: r, warning, card, speech: cleanSpeech(`Okay. I'll bring up ${sub.name} on ${spokenDate(due)}.${warning ? " " + warning : ""}`) };
}

// ---------- the simulated clock ----------

/** Moves the demo clock forward and applies renewals, scheduled changes and reminders, exactly once each. */
export function advanceClock(state: HouseholdState, toDate: string, nowMs: number) {
  if (toDate < state.today) throw new RuleError("clock_backwards", "The demo clock only moves forward. Reset the demo to start over.");
  if (daysBetween(state.today, toDate) > 120) throw new RuleError("too_far", "Move the clock at most 120 days at a time.");
  const events: string[] = [];
  state.today = toDate;
  for (const sub of state.subscriptions) {
    let guard = 0;
    while (guard++ < 24) {
      if (sub.status === "paused" && sub.pausedUntil && sub.pausedUntil <= toDate) { sub.status = "active"; sub.nextRenewal = sub.pausedUntil; sub.pausedUntil = undefined; events.push(`${sub.name} resumed`); }
      if (!(sub.status === "active" || sub.status === "cancel_pending") || sub.nextRenewal > toDate) break;
      const s = sub.scheduled;
      if (s && s.effectiveDate <= sub.nextRenewal) {
        sub.scheduled = undefined;
        if (s.kind === "cancel") { sub.status = "canceled"; events.push(`${sub.name} ended on ${s.effectiveDate}`); break; }
        if (s.kind === "pause") { sub.status = "paused"; sub.pausedUntil = addMonths(sub.nextRenewal, s.pauseMonths ?? 1); events.push(`${sub.name} paused until ${sub.pausedUntil}`); sub.version++; continue; }
        if (s.toPlanId) { sub.planId = s.toPlanId; events.push(`${sub.name} moved to ${currentPlan(sub).name}`); }
      }
      const plan = currentPlan(sub);
      state.ledger.push({ id: nextId(state, "ch"), date: sub.nextRenewal, atMs: nowMs, subscriptionId: sub.id, kind: "renewal_charge", confirmedBy: "system", amountCents: -plan.priceCents, monthlyChangeCents: 0, detail: `Renewed ${plan.name} (simulated charge)`, reversible: false });
      sub.lastCharge = { date: sub.nextRenewal, amountCents: plan.priceCents };
      sub.sessionsSinceLastCharge = 0;
      sub.nextRenewal = plan.period === "year" ? addMonths(sub.nextRenewal, 12) : addMonths(sub.nextRenewal, 1);
      sub.version++;
      events.push(`${sub.name} renewed for ${screenMoney(plan.priceCents)} (simulated)`);
    }
  }
  refreshDue(state);
  for (const p of state.proposals) if (p.status === "pending") p.status = "expired";
  return { today: state.today, events };
}

export function memory(state: HouseholdState, subId?: string) {
  const sub = subId ? getSub(state, subId) : null;
  const notes = state.memory.filter((m) => !sub || m.subscriptionId === sub.id).slice(-12);
  const reminders = state.reminders.filter((r) => (!sub || r.subscriptionId === sub.id) && r.status !== "done");
  const changes = state.ledger.filter((l) => (!sub || l.subscriptionId === sub.id) && l.kind !== "renewal_charge").slice(-8);
  const latest = notes.filter((n) => n.kind === "decision").pop() ?? notes[notes.length - 1];
  const card: Card = {
    kind: "memory", title: sub ? `What we said about ${sub.name}` : "What the family decided",
    fields: [
      { label: latest ? shortDate(latest.date) : "Notes", value: latest ? latest.text : "Nothing yet" },
      { label: "Open reminders", value: reminders.map((r) => `${getSub(state, r.subscriptionId).name} ${shortDate(r.dueDate)}`).join(", ") || "None" },
    ],
  };
  return { notes, reminders, changes, card, speech: latest ? cleanSpeech(`On ${spokenDate(latest.date)}: ${latest.text}`) : "I have no notes yet." };
}

export function usageReport(state: HouseholdState, subId: string) {
  const sub = getSub(state, subId);
  const f = usageFacts(state, sub);
  const plan = currentPlan(sub);
  const perMember = sub.usage.map((u) => ({ member: memberName(state, u.memberId), hoursLast30Days: u.hours30d, sessionsLast30Days: u.sessions30d, hoursLast60Days: u.hours60d, lastUsed: u.lastUsed, mostly: u.topTitle ?? null }));
  const top = [...sub.usage].sort((a, b) => b.hours30d - a.hours30d)[0];
  const speech = f.hours30d === 0
    ? `Nobody has used ${sub.name} in the last 30 days.${f.lastUsed ? ` The last time was ${spokenDate(f.lastUsed)}.` : ""}`
    : `${sub.name} was used ${f.hours30d} hours in the last 30 days, mostly by ${memberName(state, top.memberId)}${top.topTitle ? `, watching ${top.topTitle}` : ""}. That's about ${spokenMoney(f.costPerHourCents ?? 0)} an hour.`;
  const card: Card = {
    kind: "usage", title: `${sub.name}: ${f.hours30d} hours this month`,
    fields: [
      { label: "Mostly", value: f.hours30d ? `${memberName(state, top.memberId)}, ${top.hours30d} h` : `No one since ${f.lastUsed ? shortDate(f.lastUsed) : "ever"}` },
      { label: "Cost per hour", value: f.costPerHourCents != null ? screenMoney(f.costPerHourCents) : `${priceText(plan)} for 0 h` },
    ],
    footnote: `Source: ${sub.usageSource}`,
  };
  return { subscription: sub.name, plan: plan.name, price: priceText(plan), status: sub.status, nextRenewal: sub.nextRenewal, perMember, facts: f, events: sub.events, refund: refundEligibility(state, sub), suggestion: suggest(state, sub), source: sub.usageSource, card, speech: cleanSpeech(speech) };
}
