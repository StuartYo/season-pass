// The demo script. These are SCRIPTED voice turns (fixed text, played by the simulator), not live speech
// recognition. The screen labels them as scripted. Live voice and typing work too.
export type ScriptStep =
  | { kind: "event"; event: "morning"; label: string }
  | { kind: "say"; speaker: string; text: string; label: string };

export const DEMO_SCRIPT: ScriptStep[] = [
  { kind: "event", event: "morning", label: "Monday morning, three days before Lumen's billing day. Alexa+ speaks up on its own." },
  { kind: "say", speaker: "marcus", text: "Hold on, I'm still watching that show.", label: "Marcus changes the plan with one sentence." },
  { kind: "say", speaker: "dana", text: "Grandma wants the cooking channel this month.", label: "Dana speaks for Grandma Rosa. The plan makes room." },
  { kind: "say", speaker: "dana", text: "Okay, set it up.", label: "Code computes every amount and date. Nothing changes yet." },
  { kind: "say", speaker: "leah", text: "Yes! Do it.", label: "Leah is 15. The server refuses her yes." },
  { kind: "say", speaker: "marcus", text: "Yes, confirm.", label: "An adult on the billing account confirms." },
  { kind: "say", speaker: "dana", text: "Remind us the day before Orbit starts.", label: "A reminder for the next billing moment." },
  { kind: "say", speaker: "leah", text: "Why is Orbit off until late November?", label: "The plan explains itself, from the same data." },
];
