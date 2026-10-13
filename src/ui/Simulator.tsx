"use client";
// Echo Show style simulator for Season Pass. It is a real MCP host (official SDK client over Streamable HTTP).
// The conversation layer is pluggable: "rules" (deterministic, no AI) now, "claude" once AMAZON_ANTHROPIC_API_KEY exists.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClaudeEngine } from "@/conversation/claudeEngine";
import { RulesEngine } from "@/conversation/rulesEngine";
import { DEMO_SCRIPT } from "@/conversation/script";
import type { ConversationEngine, EngineInput, ToolResult, ToolRunner, World } from "@/conversation/types";
import { Exchange, McpHost } from "./mcpHost";
import { Cal, MoneyTicker, PlanCalendar } from "./PlanCalendar";

type Card = {
  kind: string;
  title: string;
  fields: { label: string; value: string }[];
  action?: { label: string; utterance: string; tool?: { name: string; arguments: Record<string, unknown> } };
  tone?: "neutral" | "good" | "warn";
  footnote?: string;
};
type Line = { who: string; text: string; kind: "person" | "alexa" | "event" | "system"; tag?: string };
type Screen = {
  key: number;
  card: Card | null;
  calendar: Cal | null;
  prev: Cal | null;
  costFrom: number | null;
  costTo: number | null;
  solverMs: number | null;
  highlight: string | null;
};
type AgentStatus = { configured: boolean; keyEnv: string; model: string; aiAvailable: boolean; cappedReason?: string | null };

// When several tools run in one turn, keep the card that matters most on screen.
const CARD_RANK: Record<string, number> = { blocked: 7, confirm: 6, receipt: 5, plan: 4, reminder: 3, explain: 2, briefing: 1, household: 0 };
const SHOW_CAL = new Set(["plan", "briefing", "explain", "household"]);

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const prettyDate = (d?: string) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) : "");

function householdId() {
  try {
    const k = "seasonpass-household";
    let v = localStorage.getItem(k);
    if (!v) { v = "h-" + Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
    return v;
  } catch {
    return "h-" + Math.random().toString(36).slice(2, 10);
  }
}

function summarizeArgs(args: unknown) {
  const s = JSON.stringify(args ?? {});
  return s.length > 110 ? s.slice(0, 107) + "..." : s;
}

export default function Simulator() {
  const hostRef = useRef<McpHost | null>(null);
  const engineRef = useRef<ConversationEngine>(new RulesEngine());
  const turnRef = useRef(0);
  const busyRef = useRef(false);
  const recRef = useRef<any>(null);
  const mutedRef = useRef(false);
  const autoRef = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<"rules" | "claude">("rules");
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [speaker, setSpeaker] = useState("dana");
  const [lines, setLines] = useState<Line[]>([]);
  const [screen, setScreen] = useState<Screen>({ key: 0, card: null, calendar: null, prev: null, costFrom: null, costTo: null, solverMs: null, highlight: null });
  const [lastSpoken, setLastSpoken] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState<Exchange[]>([]);
  const [house, setHouse] = useState<any>(null);
  const [tab, setTab] = useState<"tools" | "chat" | "house">("tools");
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState(0);
  const [canListen, setCanListen] = useState(false);
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(false);
  const [clockTo, setClockTo] = useState("");
  const [allRpc, setAllRpc] = useState(false);
  mutedRef.current = muted;

  const members: any[] = house?.members ?? [];

  const refreshHouse = useCallback(async () => {
    try {
      const h = await hostRef.current!.household();
      setHouse(h);
      return h;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const host = new McpHost("/api/mcp", { household: householdId(), speaker: null, turn: 0 });
    host.onLog = (l) => setLog(l);
    hostRef.current = host;
    (async () => {
      try {
        const tools = await host.listTools();
        setToolCount(tools.filter((t) => !(t._meta as any)?.["seasonpass/hostOnly"]).length);
        const h = await refreshHouse();
        if (h?.calendar) setScreen((s) => ({ ...s, calendar: h.calendar, costTo: h.plan?.costCents ?? null }));
      } catch (e: any) {
        setNotice("Could not reach the MCP server: " + String(e?.message ?? e));
      }
      try { setAgent(await (await fetch("/api/agent")).json()); } catch { /* offline */ }
    })();
    setCanListen(Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
  }, [refreshHouse]);

  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest" }); }, [lines]);

  const say = useCallback((text: string) => new Promise<void>((resolve) => {
    setLastSpoken(text);
    if (mutedRef.current || !("speechSynthesis" in window) || !text) { setTimeout(resolve, Math.min(6000, 1200 + text.length * 35)); return; }
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    u.voice = voices.find((v) => /Aria|Jenny|Samantha|Google US English/i.test(v.name)) ?? voices.find((v) => v.lang === "en-US") ?? null;
    u.rate = 1.04;
    const done = () => { setSpeaking(false); resolve(); };
    u.onstart = () => setSpeaking(true);
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }), []);

  const add = (l: Line) => setLines((x) => [...x, l].slice(-120));

  const runner: ToolRunner = useMemo(() => ({
    async call(name, args) {
      const r = await hostRef.current!.callTool(name, args);
      return { name, args, isError: Boolean(r.isError), data: r.structuredContent ?? null, text: r.content?.find((c) => c.type === "text")?.text ?? "" };
    },
  }), []);

  /** Puts the most important result on the device screen. */
  const show = useCallback((results: ToolResult[]) => {
    let best: ToolResult | null = null;
    for (const r of results) {
      const c = r.data?.card as Card | undefined;
      if (!c) continue;
      if (!best || (CARD_RANK[c.kind] ?? 0) >= (CARD_RANK[best.data.card.kind] ?? 0)) best = r;
    }
    if (!best) return;
    const d = best.data;
    const withCal = [...results].reverse().find((r) => r.data?.calendar);
    setScreen((s) => ({
      key: s.key + 1,
      card: d.card,
      calendar: (withCal?.data.calendar as Cal) ?? s.calendar,
      prev: (withCal?.data.previousCalendar as Cal) ?? null,
      costFrom: d.replan?.costBeforeCents ?? null,
      costTo: d.replan?.costAfterCents ?? d.plan?.costCents ?? s.costTo,
      solverMs: d.replan?.solverMs ?? d.plan?.solver?.ms ?? null,
      highlight: best!.name === "explain_plan" ? (house?.services?.find((x: any) => x.name === d.service)?.id ?? null) : null,
    }));
  }, [house]);

  const runTurn = useCallback(async (inp: EngineInput, who?: { id: string; name: string }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const host = hostRef.current!;
    turnRef.current += 1;
    host.ctx = { ...host.ctx, speaker: inp.type === "utterance" ? inp.speakerId : null, turn: turnRef.current };
    if (inp.type === "utterance") add({ who: who?.name ?? inp.speakerName, text: inp.text, kind: "person", tag: inp.source === "scripted" ? "Scripted voice turn" : inp.source === "voice" ? "Live voice" : "Typed" });
    else add({ who: "Device", text: `Morning routine, ${prettyDate(inp.today)}. Alexa+ speaks first.`, kind: "event" });
    try {
      const world: World = (await refreshHouse()) ?? house;
      const out = await engineRef.current.handle(inp, runner, world);
      if (out.error) { add({ who: "System", text: out.error, kind: "system" }); return; }
      if (out.fellBackToRules) {
        add({ who: "System", text: (out.notice ?? "Claude mode is capped for now.") + " Switched to rules mode; the MCP tools and rules are unchanged.", kind: "system" });
        engineRef.current = new RulesEngine();
        setMode("rules");
        setAgent((a) => (a ? { ...a, aiAvailable: false } : a));
      }
      show(out.results);
      add({ who: "Alexa", text: out.speech, kind: "alexa", tag: out.fellBackToRules || engineRef.current.mode === "rules" ? "Rules mode" : "Claude mode" });
      await refreshHouse();
      busyRef.current = false;
      setBusy(false);
      await say(out.speech);
    } catch (e: any) {
      add({ who: "System", text: "Error: " + String(e?.message ?? e), kind: "system" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [house, refreshHouse, runner, say, show]);

  const utter = useCallback(async (text: string, source: "voice" | "typed" | "scripted", who = speaker) => {
    const t = text.trim();
    if (!t) return;
    const m = members.find((x) => x.id === who);
    await runTurn({ type: "utterance", speakerId: who, speakerName: m?.name ?? who, text: t, source }, m ? { id: m.id, name: m.name } : undefined);
  }, [members, runTurn, speaker]);

  const morning = useCallback(() => runTurn({ type: "event", event: "morning", today: house?.today ?? "" }), [house, runTurn]);

  const playStep = useCallback(async (i: number) => {
    const s = DEMO_SCRIPT[i];
    if (!s) return;
    setStep(i + 1);
    if (s.kind === "event") await runTurn({ type: "event", event: "morning", today: house?.today ?? "" });
    else { setSpeaker(s.speaker); await utter(s.text, "scripted", s.speaker); }
  }, [house, runTurn, utter]);

  const playAll = useCallback(async () => {
    if (autoRef.current) { autoRef.current = false; setAuto(false); return; }
    autoRef.current = true;
    setAuto(true);
    for (let i = step; i < DEMO_SCRIPT.length && autoRef.current; i++) {
      await playStep(i);
      await new Promise((r) => setTimeout(r, 1400));
    }
    autoRef.current = false;
    setAuto(false);
  }, [playStep, step]);

  const tapAction = useCallback(async (a: NonNullable<Card["action"]>) => {
    if (!a.tool) { await utter(a.utterance, "typed"); return; }
    // A tap is the person at the screen acting directly, in a new turn, as the selected speaker.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const host = hostRef.current!;
    turnRef.current += 1;
    host.ctx = { ...host.ctx, speaker, turn: turnRef.current };
    const m = members.find((x) => x.id === speaker);
    add({ who: m?.name ?? speaker, text: `Taps "${a.label}" on the screen`, kind: "person", tag: "Screen tap" });
    try {
      const r = await runner.call(a.tool.name, a.tool.arguments);
      show([r]);
      const sp = String(r.data?.speech ?? r.text);
      add({ who: "Alexa", text: sp, kind: "alexa" });
      await refreshHouse();
      busyRef.current = false;
      setBusy(false);
      await say(sp);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [members, refreshHouse, runner, say, show, speaker]);

  const hostCall = useCallback(async (name: string, args: Record<string, unknown>) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      hostRef.current!.ctx = { ...hostRef.current!.ctx, speaker: null };
      return await runner.call(name, args);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [runner]);

  const resetDemo = useCallback(async () => {
    autoRef.current = false;
    window.speechSynthesis?.cancel();
    const r = await hostCall("demo_reset", {});
    if (!r) return;
    engineRef.current.reset();
    setLines([]);
    setStep(0);
    setLastSpoken("");
    const h = await refreshHouse();
    setScreen((s) => ({ key: s.key + 1, card: null, calendar: h?.calendar ?? null, prev: null, costFrom: null, costTo: h?.plan?.costCents ?? null, solverMs: null, highlight: null }));
  }, [hostCall, refreshHouse]);

  const moveClock = useCallback(async () => {
    if (!clockTo) return;
    const r = await hostCall("demo_advance_clock", { to_date: clockTo });
    if (!r) return;
    if (r.isError) { add({ who: "System", text: r.data?.message ?? r.text, kind: "system" }); return; }
    add({ who: "Demo clock", text: `Moved to ${prettyDate(r.data.today)}. ${(r.data.events as string[]).join("; ") || "Nothing billed."}`, kind: "system" });
    const h = await refreshHouse();
    setScreen((s) => ({ key: s.key + 1, card: null, calendar: h?.calendar ?? null, prev: null, costFrom: null, costTo: h?.plan?.costCents ?? null, solverMs: null, highlight: null }));
  }, [clockTo, hostCall, refreshHouse]);

  const switchMode = (m: "rules" | "claude") => {
    if (m === mode) return;
    engineRef.current = m === "claude" ? new ClaudeEngine() : new RulesEngine();
    setMode(m);
    add({ who: "System", text: m === "claude" ? "Conversation layer: Claude. Tool calls and rules are unchanged." : "Conversation layer: rules (no AI).", kind: "system" });
  };

  const listen = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { recRef.current?.stop(); return; }
    window.speechSynthesis?.cancel();
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setInput(t);
      if (e.results[e.results.length - 1].isFinal) finalText = t;
    };
    rec.onend = () => { setListening(false); if (finalText) { setInput(""); void utter(finalText, "voice"); } };
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening, utter]);

  const ring = listening ? "listening" : busy ? "thinking" : speaking ? "speaking" : "";
  const initEx = log.find((x) => x.method === "initialize");
  const refused = log.filter((x) => (x.response as any)?.result?.structuredContent?.error).length;
  const next = DEMO_SCRIPT[step];
  const card = screen.card;
  const calOnScreen = screen.calendar && (!card || SHOW_CAL.has(card.kind));
  const isReplan = card?.kind === "plan" && screen.prev;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4M7 14h4M13 17h4" /></svg>
          </span>
          <div>
            <h1>Season Pass</h1>
            <p>The household&apos;s streaming, on only when someone is watching. An Alexa+ add-on built as an MCP server.</p>
          </div>
        </div>
        <div className="badges">
          <span className="badge demo">Demo data: fictional services, shows and family</span>
          <span className={"badge " + (initEx ? "ok" : "")} title="Negotiated in the initialize response">MCP {hostRef.current?.protocolVersion ?? "connecting"} · Streamable HTTP</span>
          <div className="modes" role="radiogroup" aria-label="Conversation layer">
            <button role="radio" aria-checked={mode === "rules"} className={mode === "rules" ? "on" : ""} onClick={() => switchMode("rules")}>Rules mode</button>
            <button role="radio" aria-checked={mode === "claude"} className={mode === "claude" ? "on" : ""} disabled={!agent?.aiAvailable} onClick={() => switchMode("claude")} title={agent?.aiAvailable ? `Claude (${agent.model})` : agent?.configured ? (agent.cappedReason ?? "Claude mode is capped for now") : `Needs ${agent?.keyEnv ?? "AMAZON_ANTHROPIC_API_KEY"} on the server`}>Claude mode</button>
          </div>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <main className="grid">
        <section className="stage">
          <div className="script">
            <div className="script-text">
              <span className="eyebrow">Demo script · scripted voice turns, not live speech recognition</span>
              {next ? (
                <p><b>{step + 1}/{DEMO_SCRIPT.length}</b> {next.kind === "say" ? <><q>{next.text}</q> <span className="muted">{members.find((m) => m.id === next.speaker)?.name ?? next.speaker}</span></> : <span>Morning routine</span>} <span className="muted">· {next.label}</span></p>
              ) : (
                <p className="muted">Script finished. Talk to it, move the clock, or reset.</p>
              )}
            </div>
            <div className="script-buttons">
              <button className="primary" onClick={() => playStep(step)} disabled={busy || auto || !next}>Play next turn</button>
              <button onClick={playAll} disabled={(!next && !auto) || (busy && !auto)}>{auto ? "Stop" : "Play all"}</button>
            </div>
          </div>

          <div className={"device " + (voiceOnly ? "voice-only" : "")}>
            <div className="bezel">
              <div className="screen">
                {voiceOnly ? (
                  <div className="dark-screen"><div className={"orb " + ring} /><span>Voice-only device: everything is in the spoken reply.</span></div>
                ) : (
                  <>
                    <div className="screen-top">
                      <span>{house ? `7:30 AM · ${prettyDate(house.today)}` : ""}</span>
                      <span className="sp-mark">Season Pass</span>
                    </div>
                    <div className={"screen-body" + (calOnScreen ? " with-cal" : "")} key={screen.key}>
                      {card ? (
                        <div className={"card tone-" + (card.tone ?? "neutral") + " kind-" + card.kind}>
                          <div className="card-head">
                            <h2>{card.title}</h2>
                            {isReplan && screen.solverMs != null && <span className="chip live">Re-planned in {screen.solverMs} ms</span>}
                          </div>
                          {card.kind === "plan" && calOnScreen && screen.calendar && (
                            <PlanCalendar cal={screen.calendar} prev={screen.prev} animateKey={screen.key} compact={false} />
                          )}
                          <div className="fields">
                            {card.fields.map((f, i) => (
                              <div key={f.label} className="field">
                                <span>{f.label}</span>
                                <strong>{card.kind === "plan" && i === 0 && screen.costTo != null ? <><MoneyTicker from={screen.costFrom} to={screen.costTo} />{screen.costFrom != null && screen.costTo !== screen.costFrom && <em className={screen.costTo > screen.costFrom ? "up" : "down"}>{screen.costTo > screen.costFrom ? "+" : "-"}{money(Math.abs(screen.costTo - screen.costFrom))}</em>}</> : f.value}</strong>
                              </div>
                            ))}
                          </div>
                          {card.kind !== "plan" && calOnScreen && screen.calendar && <PlanCalendar cal={screen.calendar} animateKey={screen.key} highlight={screen.highlight} compact />}
                          {card.action && (
                            <button className="card-action" onClick={() => tapAction(card.action!)} disabled={busy}>{card.action.label}</button>
                          )}
                          {card.footnote && <p className="foot">{card.footnote}</p>}
                        </div>
                      ) : (
                        <div className="idle">
                          <p className="big">{house ? prettyDate(house.today).split(",")[0] : ""}</p>
                          {screen.calendar && <PlanCalendar cal={screen.calendar} animateKey={screen.key} compact />}
                          <p className="idle-sub">{house?.plan ? `This plan through April: ${house.plan.cost}. Keeping every service on: ${money(house.plan.keepAllOnCents)}.` : "Connecting to the MCP server"}</p>
                        </div>
                      )}
                    </div>
                    <div className="caption">{lastSpoken}</div>
                  </>
                )}
                <div className={"lightbar " + ring} />
              </div>
            </div>
            <div className="device-base" />
          </div>

          <div className="speakers" role="radiogroup" aria-label="Who is speaking">
            <span className="label">Who is speaking<small>Stands in for Alexa voice recognition</small></span>
            {members.map((m) => (
              <button key={m.id} role="radio" aria-checked={speaker === m.id} className={"who " + (speaker === m.id ? "on" : "")} onClick={() => setSpeaker(m.id)}>
                <span className="avatar">{m.name[0]}</span>
                <span className="who-text"><b>{m.name}</b><small>{m.canApproveCharges ? "Approves charges" : m.role === "adult" ? "Adult" : `${m.role === "teen" ? "Teen" : "Child"}, ${m.age}`}</small></span>
              </button>
            ))}
          </div>

          <form className="composer" onSubmit={(e) => { e.preventDefault(); const t = input; setInput(""); void utter(t, "typed"); }}>
            <button type="button" className={"mic " + (listening ? "on" : "")} onClick={listen} disabled={!canListen || busy} title={canListen ? "Push to talk (Web Speech API)" : "Voice input needs Chrome or Edge. Type instead."} aria-label="Push to talk">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Say something as ${members.find((m) => m.id === speaker)?.name ?? "..."}`} aria-label="What the speaker says" />
            <button className="primary" type="submit" disabled={busy || !input.trim()}>{busy ? "Working" : "Say it"}</button>
          </form>

          <div className="controls">
            <button onClick={morning} disabled={busy}>Morning reminder</button>
            <label className="skip">Move clock to <input type="date" value={clockTo} min={house?.today} max="2027-04-30" onChange={(e) => setClockTo(e.target.value)} aria-label="Move demo clock to" /></label>
            <button onClick={moveClock} disabled={busy || !clockTo}>Go</button>
            <button onClick={resetDemo} disabled={busy}>Reset demo</button>
            <span className="spacer" />
            <label className="toggle"><input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} /> Voice-only device</label>
            <label className="toggle"><input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); if (e.target.checked) window.speechSynthesis?.cancel(); }} /> Mute</label>
          </div>
        </section>

        <aside className="panel">
          <nav className="tabs">
            <button className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>Tool calls <span className="count">{log.filter((x) => x.method === "tools/call").length}</span>{refused > 0 && <span className="count warn">{refused} refused</span>}</button>
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Conversation</button>
            <button className={tab === "house" ? "on" : ""} onClick={() => setTab("house")}>Household</button>
          </nav>

          {tab === "tools" && (
            <div className="traffic">
              <p className="hint">JSON-RPC between this simulator (the MCP host) and the Season Pass MCP server. {toolCount} assistant tools; the demo clock tools are host-only. Amounts, plans and refusals come from server code, not from the conversation layer.</p>
              <label className="toggle small"><input type="checkbox" checked={allRpc} onChange={(e) => setAllRpc(e.target.checked)} /> Also show screen refreshes (resources/read) and notifications</label>
              {[...log].reverse().filter((x) => allRpc || (x.method !== "resources/read" && !x.method.startsWith("notifications/"))).map((x) => {
                const req = x.request as any;
                const res = x.response as any;
                const sc = res?.result?.structuredContent;
                return (
                  <div key={x.id} className={"ex " + (x.error ? "err" : "")}>
                    <button className="ex-head" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                      <span className="method">{x.method}{x.tool ? <b> {x.tool}</b> : null}</span>
                      <span className="meta">{x.speaker ? `${x.speaker} · ` : ""}turn {x.turn} · {x.ms} ms</span>
                    </button>
                    {x.method === "tools/call" && <div className="ex-args">{summarizeArgs(req?.params?.arguments)}</div>}
                    {x.method === "initialize" && res?.result && <div className="ex-note">protocolVersion <b>{res.result.protocolVersion}</b> · server {res.result.serverInfo?.name} {res.result.serverInfo?.version}</div>}
                    {sc?.error && <div className="ex-note">Refused by server rule <b>{sc.error}</b>: {sc.message}</div>}
                    {sc?.replan && <div className="ex-note good">Solver {sc.replan.solverMs} ms · {sc.replan.deltaCents === 0 ? "same cost" : `${sc.replan.deltaCents > 0 ? "+" : "-"}${money(Math.abs(sc.replan.deltaCents))}`} · {sc.replan.missedAfter === 0 ? "nothing missed" : `${sc.replan.missedAfter} missed`}</div>}
                    {sc?.confirmationId && <div className="ex-note">Confirmation {sc.confirmationId}: waits for {sc.needsApprovalFrom?.join(" or ")}</div>}
                    {open === x.id && <pre>{JSON.stringify({ request: x.request, response: x.response }, null, 2)}</pre>}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "chat" && (
            <div className="chat">
              {lines.length === 0 && <p className="hint">Nothing said yet. Play the first scripted turn.</p>}
              {lines.map((l, i) => (
                <div key={i} className={"line " + l.kind}>
                  <span>{l.who}{l.tag && <em className={"tag " + (l.tag === "Scripted voice turn" ? "scripted" : "")}>{l.tag}</em>}</span>
                  <p>{l.text}</p>
                </div>
              ))}
              <div ref={transcriptEnd} />
            </div>
          )}

          {tab === "house" && house && (
            <div className="house">
              <p className="hint">{house.dataNotice} Read from the MCP resource <code>seasonpass://household</code>.</p>
              <h3>Services</h3>
              <table>
                <tbody>
                  {house.services.map((s: any) => (
                    <tr key={s.id}><td><b>{s.name}</b><small>{s.price}/mo</small></td><td>{s.status}</td></tr>
                  ))}
                </tbody>
              </table>
              <h3>Who follows what</h3>
              <table>
                <tbody>
                  {house.shows.map((t: any) => (
                    <tr key={t.id}><td><b>{t.name}</b><small>{t.service}</small></td><td>{t.followers.length ? t.followers.join(", ") : <span className="muted">nobody</span>}{t.nextEpisode && <small>next episode {t.nextEpisode.release}</small>}</td></tr>
                  ))}
                  {house.requests.map((r: any, i: number) => (
                    <tr key={"r" + i}><td><b>{r.service}</b><small>request</small></td><td>{r.for.join(", ")}<small>on by {r.startBy}</small></td></tr>
                  ))}
                </tbody>
              </table>
              <h3>What people said (household memory)</h3>
              {house.preferences.length ? house.preferences.map((p: any) => <p key={p.id} className="row">{p.date} · {p.text}</p>) : <p className="row muted">Nothing yet</p>}
              <h3>Reminders</h3>
              {house.reminders.length ? house.reminders.map((r: any) => <p key={r.id} className="row">{r.dueDate} · {r.note} <span className={"pill " + r.status}>{r.status}</span></p>) : <p className="row muted">None</p>}
              <h3>Ledger</h3>
              {house.ledger.length ? [...house.ledger].reverse().map((l: any) => <p key={l.id} className="row">{l.date} · {l.detail}{l.amountCents ? ` · ${money(l.amountCents)}` : ""}{l.undone ? " · undone" : ""}</p>) : <p className="row muted">No changes yet</p>}
              <h3>Plan</h3>
              <p className="row">{house.plan.cost} through {house.plan.through} · {house.plan.followedEpisodes - house.plan.missedEpisodes} of {house.plan.followedEpisodes} followed episodes in time · {house.plan.solver.name}, {house.plan.solver.ms} ms</p>
            </div>
          )}
        </aside>
      </main>
      <p className="foot-note">Fictional demo. No real streaming service, show, payment or account is involved. Season Pass is not affiliated with Amazon.</p>
    </div>
  );
}
