// Season Pass state. Every amount is in US cents (integers). DEMO DATA ONLY: all services, shows and people are fictional.
import type { Period, Title } from "../rotation/model";

export type Role = "adult" | "teen" | "child";

export interface SPMember {
  id: string;
  name: string;
  /** Other words people use for this member, e.g. "grandma". */
  aliases: string[];
  role: Role;
  age: number;
  /** Only members with billing authority can confirm a switch that moves money. */
  billingAuthority: boolean;
  /** Watches a new episode within this many days of release. */
  watchWithinDays: number;
}

export interface SPService {
  id: string;
  name: string;
  priceCents: number; // one month
  /** Always on (for example the kids' service). Outside the household limit. */
  required: boolean;
  /** Words people use for it, e.g. "cooking channel". */
  tags: string[];
  /** Access is paid until this date (exclusive). null = off. */
  paidThrough: string | null;
  /** If true, it renews on paidThrough. Turning a service off means setting this to false. */
  autoRenew: boolean;
  /** A confirmed "turn on" date in the future, or null. */
  scheduledStart: string | null;
}

export type PreferenceKind = "follow_title" | "drop_title" | "want_service" | "set_pace" | "set_limit";

/** One change the household asked for by voice (or on screen). Kept as the household's memory. */
export interface Preference {
  id: string;
  date: string; // simulated date
  turn: number;
  speakerId: string;
  forMemberId: string;
  kind: PreferenceKind;
  titleId?: string;
  serviceId?: string;
  startBy?: string;
  days?: number;
  limit?: number | null;
  /** Plain words, for the memory panel and the explanation. */
  text: string;
  source: "voice" | "screen";
}

export interface PlanSnapshot {
  version: number;
  computedOn: string; // simulated date the plan starts
  horizonEnd: string;
  periods: Period[]; // optional services only; required services renew on their own
  costCents: number; // whole household, required services included
  missed: number;
  missedByTitle: Record<string, number>;
  pairs: number; // (episode, follower) pairs in the horizon
  solverMs: number;
  solverStatus: string;
  /** Reference points, computed by the same scorer. */
  keepAllOnCents: number; // every service on every month
  cause: string;
}

export type ActionKind = "turn_off" | "keep" | "turn_on" | "cancel_start";

export interface SwitchAction {
  serviceId: string;
  kind: ActionKind;
  date: string;
  /** turn_on / keep: charged on `date`. turn_off: the charge avoided on `date`. cancel_start: 0. */
  amountCents: number;
  /** Already set up this way; nothing to change. */
  alreadySet: boolean;
  /** Plain-words reason, computed from the plan. */
  why: string;
}

export interface Proposal {
  id: string; // confirmation id
  planVersion: number;
  stateKey: string;
  actions: SwitchAction[];
  chargeCents: number;
  avoidedCents: number;
  summary: string;
  speech: string;
  createdTurn: number;
  createdAtMs: number;
  expiresAtMs: number;
  proposedBy: string | null;
  status: "pending" | "confirmed" | "expired" | "superseded";
}

export interface ServiceSnapshot {
  serviceId: string;
  autoRenew: boolean;
  scheduledStart: string | null;
}

export interface LedgerEntry {
  id: string;
  date: string; // simulated date
  atMs: number;
  kind: "switch" | "undo" | "charge" | "lapse";
  by: string; // member id or "system"
  serviceIds: string[];
  actions?: SwitchAction[];
  /** Money moved on `date` (charges negative). Switches move no money when confirmed. */
  amountCents: number;
  detail: string;
  /** Undo is possible before this date (the first action's date). */
  undoBefore?: string;
  undone?: boolean;
  before?: ServiceSnapshot[];
}

export interface Reminder {
  id: string;
  dueDate: string;
  note: string;
  createdBy: string;
  serviceId?: string;
  status: "scheduled" | "due" | "done";
}

export interface SeasonState {
  householdId: string;
  householdName: string;
  today: string;
  horizonEnd: string;
  /** At most this many non-required services on at once (a household rule). null = no limit. */
  maxConcurrent: number | null;
  members: SPMember[];
  services: SPService[];
  titles: Title[];
  preferences: Preference[];
  /** Bumped whenever anything the planner reads changes. */
  inputsVersion: number;
  plan: PlanSnapshot | null;
  proposals: Proposal[];
  ledger: LedgerEntry[];
  reminders: Reminder[];
  dataNotice: string;
  seq: number;
}

/** Who is talking, as the host reports it (Alexa+ voice recognition in production, a tap in the simulator). */
export interface CallContext {
  householdId: string;
  speakerId: string | null;
  turn: number;
  nowMs: number;
}

export class RuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
