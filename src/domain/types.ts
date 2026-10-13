// Core data model for RenewWise. Every amount is in US cents (integers) so money math is exact.

export type MemberId = string;
export type Role = "adult" | "teen" | "child";

export interface Member {
  id: MemberId;
  name: string;
  role: Role;
  age: number;
  /** Only members with billing authority can confirm a change that affects money. */
  billingAuthority: boolean;
}

export interface Plan {
  id: string;
  name: string;
  priceCents: number;
  period: "month" | "year";
  /** Max number of household members who can use this plan (undefined = no limit). */
  maxMembers?: number;
  /** Short note a person would care about, e.g. "includes ads". */
  note?: string;
}

/** The provider's published terms. These live in code, never in the model. */
export interface ProviderPolicy {
  /** Cancelling keeps access until the end of the paid period, then billing stops. */
  cancelEffective: "end_of_period";
  /** Allowed pause lengths in months; empty means the provider does not offer pause. */
  pauseMonths: number[];
  /** Full refund of the latest charge if asked within this many days of the charge... */
  refundWindowDays: number;
  /** ...and the household used the service at most this many times since that charge. */
  refundMaxSessionsSinceCharge: number;
}

export interface UsageStat {
  memberId: MemberId;
  hours30d: number;
  sessions30d: number;
  hours60d: number;
  lastUsed: string | null; // YYYY-MM-DD
  /** What they mostly used it for, e.g. a series title (fictional). */
  topTitle?: string;
}

export interface UpcomingEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  /** Member who cares about this event. */
  memberId: MemberId;
}

export type SubStatus = "active" | "cancel_pending" | "canceled" | "paused" | "refunded";

export interface Subscription {
  id: string;
  name: string; // fictional brand
  category: "video" | "music" | "fitness";
  /** Where the usage signal comes from (simulated). */
  usageSource: string;
  planId: string;
  plans: Plan[];
  policy: ProviderPolicy;
  status: SubStatus;
  nextRenewal: string; // YYYY-MM-DD
  lastCharge: { date: string; amountCents: number } | null;
  sessionsSinceLastCharge: number;
  /** A change waiting for the renewal date (cancel, pause, downgrade). */
  scheduled?: ScheduledChange;
  pausedUntil?: string;
  usage: UsageStat[];
  events: UpcomingEvent[];
  /** Incremented on every change, so a stale confirmation can be detected. */
  version: number;
}

export type ActionKind = "cancel" | "pause" | "downgrade" | "switch_plan" | "refund_and_cancel" | "keep";

export interface ScheduledChange {
  changeId: string;
  kind: ActionKind;
  effectiveDate: string;
  toPlanId?: string;
  pauseMonths?: number;
}

export interface Vote {
  memberId: MemberId;
  preference: "keep" | "cancel" | "pause" | "downgrade";
  reason: string;
  at: string; // simulated date
}

export interface MemoryNote {
  id: string;
  date: string;
  subscriptionId?: string;
  memberId?: MemberId;
  text: string;
  kind: "decision" | "note" | "vote";
}

export interface Reminder {
  id: string;
  subscriptionId: string;
  createdBy: MemberId | "assistant";
  /** Fires on this date (simulated clock). */
  dueDate: string;
  /** If set, the reminder was tied to an event like a season finale. */
  eventId?: string;
  note: string;
  status: "scheduled" | "due" | "done";
}

/** A fully computed proposal, frozen until a person with authority confirms it. */
export interface Proposal {
  id: string; // confirmation id
  subscriptionId: string;
  subscriptionVersion: number;
  kind: ActionKind;
  toPlanId?: string;
  pauseMonths?: number;
  effectiveDate: string;
  monthlyChangeCents: number; // negative = saves money per month
  refundCents: number;
  reversible: boolean;
  summary: string; // screen text
  speech: string; // voice text, no symbols
  createdTurn: number;
  createdAtMs: number;
  expiresAtMs: number;
  proposedFor: MemberId | null;
  status: "pending" | "confirmed" | "expired" | "superseded";
}

export interface LedgerEntry {
  id: string; // change id
  date: string; // simulated date
  atMs: number;
  subscriptionId: string;
  kind: ActionKind | "undo" | "renewal_charge";
  confirmedBy: MemberId | "system";
  amountCents: number; // money moved now (refund positive, charge negative)
  monthlyChangeCents: number;
  detail: string;
  reversible: boolean;
  undone?: boolean;
  /** Snapshot to restore on undo. */
  before?: Pick<Subscription, "status" | "planId" | "scheduled" | "pausedUntil">;
}

export interface HouseholdState {
  householdId: string;
  householdName: string;
  today: string; // simulated date, YYYY-MM-DD
  members: Member[];
  subscriptions: Subscription[];
  votes: Record<string, Vote[]>; // by subscription id
  memory: MemoryNote[];
  reminders: Reminder[];
  proposals: Proposal[];
  ledger: LedgerEntry[];
  /** Clearly labels that all data is fictional. */
  dataNotice: string;
  seq: number;
}

/** Who is talking, as the host (Alexa+ voice ID in production, a tap in the simulator) reports it. */
export interface CallContext {
  householdId: string;
  speakerId: MemberId | null;
  turn: number;
  nowMs: number;
}

export class RuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
