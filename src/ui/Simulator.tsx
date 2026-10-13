"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Exchange, McpHost } from "./mcpHost";

type Card = {
  kind: string;
  title: string;
  fields: { label: string; value: string }[];
  action?: { label: string; utterance: string; tool?: { name: string; arguments: Record<string, unknown> } };
  tone?: "neutral" | "good" | "warn";
  footnote?: string;
};
type Line = { who: string; text: string; kind: "person" | "alexa" | "event" | "system" };
type Member = { id: string; name: string; role: string; age: number; billingAuthority: boolean };
type AgentStatus = { model: string; aiAvailable: boolean; spentTodayUsd: number; capUsd: number };

const SUGGESTIONS: Record<string, string[]> = {
  dana: ["What renews this week?", "StreamVale is too expensive. Let's cancel it.", "Yes, confirm.", "Remind us after the finale.", "Undo the StreamVale change."],
  marcus: ["KinoBox can go, I haven't watched it in ages.", "Did I use FitLoop at all? If not, get the money back.", "Yes, go ahead."],
  leah: ["No! The Harbor Lights finale is next week.", "Yes, confirm.", "What did we decide about StreamVale?"],
  theo: ["Are we keeping the music one?", "Yes!"],
};

// When several tools run in one step, keep the card that matters most on screen.
const CARD_RANK: Record<string, number> = { blocked: 7, confirm: 6, receipt: 5, votes: 4, reminder: 3, usage: 2, memory: 1, briefing: 0 };

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addDays(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(date?: string) {
  if (!date) return "";
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function householdId() {
  try {
    const k = "renewwise-household";
    let v = localStorage.getItem(k);
    if (!v) { v = "h-" + Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
    return v;
  } catch {
    return "h-" + Math.random().toString(36).slice(2, 10);
  }
}

export default function Simulator() {
  const hostRef = useRef<McpHost | null>(null);
  const messagesRef = useRef<any[]>([]);
  const turnRef = useRef(0);
  const busyRef = useRef(false);
  const recRef = useRef<any>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const [speaker, setSpeaker] = useState("dana");
  const [lines, setLines] = useState<Line[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [lastSpoken, setLastSpoken] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState<Exchange[]>([]);
  const [house, setHouse] = useState<any>(null);
  const [tab, setTab] = useState<"traffic" | "chat" | "house">("traffic");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState(0);
  const [canListen, setCanListen] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const members: Member[] = house?.members ?? [];
  const speakerMember = members.find((m) => m.id === speaker);

  const refreshHouse = useCallback(async () => {
    try { setHouse(await hostRef.current!.household()); } catch { /* shown in traffic */ }
  }, []);

  useEffect(() => {
    const host = new McpHost("/api/mcp", { household: householdId(), speaker: null, turn: 0 });
    host.onLog = (l) => setLog(l);
    hostRef.current = host;
    (async () => {
      try {
        const tools = await host.listTools();
        setToolCount(tools.filter((t) => !(t._meta as any)?.["renewwise/hostOnly"]).length);
        await refreshHouse();
      } catch (e: any) {
        setNotice("Could not reach the MCP server: " + String(e?.message ?? e));
      }
      try { setStatus(await (await fetch("/api/agent")).json()); } catch { /* offline */ }
    })();
    setCanListen(typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
  }, [refreshHouse]);

  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest" }); }, [lines]);

  const say = useCallback((text: string) => {
    setLastSpoken(text);
    if (mutedRef.current || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    u.voice = voices.find((v) => /Aria|Jenny|Samantha|Google US English/i.test(v.name)) ?? voices.find((v) => v.lang === "en-US") ?? null;
    u.rate = 1.03;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.speak(u);
  }, []);

  const add = (l: Line) => setLines((x) => [...x, l].slice(-80));

  /** The host-side agent loop: Claude picks tools, the host runs them over MCP, results go back to Claude. */
  const runAssistant = useCallback(async (userBlock: string) => {
    const host = hostRef.current!;
    if (messagesRef.current.length > 90) messagesRef.current = [];
    messagesRef.current.push({ role: "user", content: [{ type: "text", text: userBlock }] });
    let shown: Card | null = null;
    const show = (c: Card) => { if (!shown || (CARD_RANK[c.kind] ?? 0) >= (CARD_RANK[shown.kind] ?? 0)) { shown = c; setCard(c); } };
    for (let i = 0; i < 8; i++) {
      const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: messagesRef.current }) });
      const data = await res.json();
      if (!res.ok) {
        messagesRef.current.pop();
        if (data.budget) setStatus((s) => (s ? { ...s, aiAvailable: false } : s));
        add({ who: "System", text: data.error ?? "The assistant is unavailable.", kind: "system" });
        return false;
      }
      setStatus((s) => (s ? { ...s, spentTodayUsd: data.spentTodayUsd } : s));
      messagesRef.current.push({ role: "assistant", content: data.content });
      const texts = (data.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      const uses = (data.content as any[]).filter((b) => b.type === "tool_use");
      if (texts && uses.length) add({ who: "Alexa", text: texts, kind: "alexa" });
      if (!uses.length) {
        if (texts) { add({ who: "Alexa", text: texts, kind: "alexa" }); say(texts); }
        return true;
      }
      const results: any[] = [];
      for (const u of uses) {
        const r = await host.callTool(u.name, u.input ?? {});
        const sc = r.structuredContent;
        if (sc?.card) show(sc.card);
        let payload: string;
        if (sc) { const { card: _c, ...rest } = sc; payload = JSON.stringify(rest); } else payload = r.content.map((c) => c.text ?? "").join("\n");
        results.push({ type: "tool_result", tool_use_id: u.id, content: payload.slice(0, 12000), is_error: Boolean(r.isError) });
      }
      messagesRef.current.push({ role: "user", content: results });
      void refreshHouse();
    }
    add({ who: "System", text: "Stopped after 8 steps to keep the demo cheap.", kind: "system" });
    return false;
  }, [refreshHouse, say]);

  const guarded = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await fn(); } catch (e: any) { add({ who: "System", text: String(e?.message ?? e), kind: "system" }); }
    finally { busyRef.current = false; setBusy(false); }
  }, []);

  const sendUtterance = useCallback((text: string) => guarded(async () => {
    const t = text.trim().slice(0, 300);
    if (!t) return;
    const m = members.find((x) => x.id === speaker);
    turnRef.current += 1;
    hostRef.current!.ctx = { ...hostRef.current!.ctx, speaker, turn: turnRef.current };
    add({ who: m?.name ?? speaker, text: t, kind: "person" });
    setInput("");
    const role = m ? `${m.role}, ${m.age}, ${m.billingAuthority ? "can approve billing" : "cannot approve billing"}` : "unknown";
    await runAssistant(`<turn speaker="${esc(m?.name ?? speaker)}" role="${esc(role)}" n="${turnRef.current}">${esc(t)}</turn>`);
  }), [guarded, members, speaker, runAssistant]);

  const sendEvent = useCallback(async (type: string, description: string) => {
    turnRef.current += 1;
    hostRef.current!.ctx = { ...hostRef.current!.ctx, speaker: null, turn: turnRef.current };
    add({ who: "Device", text: description, kind: "event" });
    const date = house?.today ?? "";
    const ok = await runAssistant(`<event type="${type}" date="${date}" time="7:30 AM">${esc(description)}</event>`);
    if (!ok && type.includes("briefing")) {
      // Assistant offline: still show what the MCP server says, so the demo degrades gracefully.
      const r = await hostRef.current!.callTool("get_renewal_briefing", {});
      if (r.structuredContent?.card) setCard(r.structuredContent.card);
      if (r.structuredContent?.speech) { add({ who: "RenewWise", text: r.structuredContent.speech, kind: "alexa" }); say(r.structuredContent.speech); }
    }
  }, [house, runAssistant, say]);

  /** A tap on the Echo Show card. Confirm and Undo call the MCP tool directly as the person who tapped. */
  const tapAction = useCallback((action: NonNullable<Card["action"]>) => {
    if (!action.tool) return sendUtterance(action.utterance);
    return guarded(async () => {
      const m = members.find((x) => x.id === speaker);
      turnRef.current += 1;
      const host = hostRef.current!;
      host.ctx = { ...host.ctx, speaker, turn: turnRef.current };
      add({ who: m?.name ?? speaker, text: `Tapped "${action.label}" on the screen`, kind: "person" });
      const r = await host.callTool(action.tool!.name, action.tool!.arguments);
      const sc = r.structuredContent;
      const before = card;
      if (sc?.card) setCard(sc.card);
      // A refusal about who tapped leaves the proposal open, so bring its card back for the right person.
      if (r.isError && before && ["not_authorized", "unknown_speaker", "needs_new_turn"].includes(sc?.error)) {
        setTimeout(() => setCard((c) => (c?.kind === "blocked" ? before : c)), 3500);
      }
      await refreshHouse();
      const result = sc?.speech ?? r.content.map((c) => c.text ?? "").join(" ");
      await runAssistant(`<event type="screen_tap" speaker="${esc(m?.name ?? speaker)}" n="${turnRef.current}">${esc(m?.name ?? speaker)} tapped ${esc(action.label)} on the screen. The host called ${action.tool!.name} directly. RenewWise answered${r.isError ? " with a refusal" : ""}: ${esc(result)} Do not call ${action.tool!.name} again for this tap; just respond briefly.</event>`);
    });
  }, [guarded, members, speaker, card, refreshHouse, runAssistant, sendUtterance]);

  const newConversation = () => { messagesRef.current = []; };

  const briefing = () => guarded(async () => {
    newConversation();
    add({ who: "System", text: "New conversation. The assistant remembers only what RenewWise stored.", kind: "system" });
    await sendEvent("morning_briefing", "Morning briefing on the kitchen Echo Show. The family is having breakfast.");
  });

  const skipTo = (date: string) => guarded(async () => {
    const host = hostRef.current!;
    host.ctx = { ...host.ctx, speaker: null };
    const r = await host.callTool("demo_advance_clock", { to_date: date });
    if (r.isError) { add({ who: "System", text: r.content[0]?.text ?? "Could not move the clock.", kind: "system" }); return; }
    const events: string[] = r.structuredContent?.events ?? [];
    add({ who: "System", text: `Clock moved to ${prettyDate(date)}.${events.length ? " " + events.join(". ") + "." : ""}`, kind: "system" });
    await refreshHouse();
    newConversation();
    setCard(null);
    await sendEvent("morning_briefing", `A new day. Morning briefing on the kitchen Echo Show.`);
  });

  const resetDemo = () => guarded(async () => {
    const host = hostRef.current!;
    host.ctx = { ...host.ctx, speaker: null };
    await host.callTool("demo_reset", {});
    newConversation();
    turnRef.current = 0;
    setLines([]); setCard(null); setLastSpoken("");
    await refreshHouse();
  });

  const listen = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { recRef.current?.stop(); return; }
    window.speechSynthesis?.cancel();
    const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const res = e.results[e.results.length - 1];
      setInput(res[0].transcript);
      if (res.isFinal) { rec.stop(); void sendUtterance(res[0].transcript); }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const initEx = log.find((x) => x.method === "initialize");
  const blocked = log.filter((x) => x.method === "tools/call" && x.error).length;
  const now = house?.today;
  const ring = listening ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  const subs: any[] = house?.subscriptions ?? [];
  const nextDay = now ? addDays(now, 1) : "";

  const quick = useMemo(() => SUGGESTIONS[speaker] ?? [], [speaker]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M17.7 3v3.4h-3.4M6.3 21v-3.4h3.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <h1>RenewWise</h1>
            <p>Alexa+ add-on simulator. A family decides together before a subscription renews.</p>
          </div>
        </div>
        <div className="badges">
          <span className="badge demo">Demo data, fictional household</span>
          <span className={"badge " + (initEx ? "ok" : "")} title="Negotiated in the initialize response">
            MCP {hostRef.current?.protocolVersion ?? "connecting"} · Streamable HTTP
          </span>
          {status && <span className="badge" title="Daily AI budget for this public demo">AI {status.aiAvailable ? `on, ${money(Math.round((status.capUsd - status.spentTodayUsd) * 100))} left today` : "offline"}</span>}
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <main className="grid">
        <section className="stage">
          <div className="controls">
            <button className="primary" onClick={briefing} disabled={busy}>Morning briefing</button>
            <button onClick={() => skipTo(nextDay)} disabled={busy || !now}>Next day</button>
            <label className="skip">
              Skip to
              <input type="date" value="" min={nextDay} onChange={(e) => e.target.value && skipTo(e.target.value)} disabled={busy || !now} />
            </label>
            <button onClick={() => { newConversation(); add({ who: "System", text: "New conversation started.", kind: "system" }); }} disabled={busy}>New conversation</button>
            <button onClick={resetDemo} disabled={busy}>Reset demo</button>
            <span className="spacer" />
            <label className="toggle"><input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} /> Voice-only device</label>
            <label className="toggle"><input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); if (e.target.checked) window.speechSynthesis?.cancel(); }} /> Mute</label>
          </div>

          <div className={"device " + (voiceOnly ? "voice-only" : "")}>
            <div className="bezel">
              <div className="screen">
                {voiceOnly ? (
                  <div className="dark-screen">
                    <div className={"orb " + ring} />
                    <p>No screen. Everything has to work by voice.</p>
                  </div>
                ) : (
                  <>
                    <div className="screen-top">
                      <span>RenewWise</span>
                      <span>{prettyDate(now)} · 7:30 AM</span>
                    </div>
                    <div className="screen-body">
                      {card ? (
                        <div className={"card tone-" + (card.tone ?? "neutral") + " kind-" + card.kind}>
                          <h2>{card.title}</h2>
                          <div className="fields">
                            {card.fields.slice(0, 2).map((f) => (
                              <div key={f.label} className="field"><span>{f.label}</span><strong>{f.value}</strong></div>
                            ))}
                          </div>
                          {card.action && (
                            <button className="card-action" onClick={() => tapAction(card.action!)} disabled={busy}>
                              {card.action.label}
                            </button>
                          )}
                          {card.footnote && <p className="foot">{card.footnote}</p>}
                        </div>
                      ) : (
                        <div className="idle">
                          <p className="big">{now ? prettyDate(now).split(",")[0] : ""}</p>
                          <p>Press Morning briefing, or pick who is speaking and say “What renews this week?”</p>
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

          {voiceOnly && (
            <div className="spoken">
              <span>Exact words spoken</span>
              <p>{lastSpoken || "Nothing yet."}</p>
            </div>
          )}

          <div className="speakers" role="radiogroup" aria-label="Who is speaking">
            <span className="label">Who is speaking<small>Stands in for Alexa voice recognition</small></span>
            {members.map((m) => (
              <button key={m.id} role="radio" aria-checked={speaker === m.id} className={"who " + (speaker === m.id ? "on" : "")} onClick={() => setSpeaker(m.id)}>
                <span className="avatar">{m.name[0]}</span>
                <span className="who-text"><b>{m.name}</b><small>{m.billingAuthority ? "Can approve billing" : m.role === "teen" ? `Teen, ${m.age}` : `Child, ${m.age}`}</small></span>
              </button>
            ))}
          </div>

          <form className="composer" onSubmit={(e) => { e.preventDefault(); void sendUtterance(input); }}>
            <button type="button" className={"mic " + (listening ? "on" : "")} onClick={listen} disabled={!canListen || busy} title={canListen ? "Push to talk" : "Voice input needs Chrome or Edge. Type instead."} aria-label="Push to talk">
              <svg viewBox="0 0 24 24" width="20" height="20"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`${speakerMember?.name ?? "Someone"} says...`} maxLength={300} disabled={busy} />
            <button className="primary" type="submit" disabled={busy || !input.trim()}>{busy ? "Thinking" : "Say it"}</button>
          </form>
          <div className="quick">
            {quick.map((q) => <button key={q} onClick={() => sendUtterance(q)} disabled={busy}>{q}</button>)}
          </div>
        </section>

        <aside className="panel">
          <nav className="tabs">
            <button className={tab === "traffic" ? "on" : ""} onClick={() => setTab("traffic")}>MCP traffic <span className="count">{log.length}</span>{blocked > 0 && <span className="count warn">{blocked} refused</span>}</button>
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Conversation</button>
            <button className={tab === "house" ? "on" : ""} onClick={() => setTab("house")}>Household</button>
          </nav>

          {tab === "traffic" && (
            <div className="traffic">
              <p className="hint">Every JSON-RPC message between this simulator (the MCP host) and the RenewWise MCP server. {toolCount} assistant tools; demo clock tools are host-only. Refusals come from server code, not the model.</p>
              {[...log].reverse().map((x) => {
                const res: any = x.response;
                const sc = res?.result?.structuredContent;
                return (
                  <div key={x.id} className={"ex " + (x.error ? "err" : "")}>
                    <button className="ex-head" onClick={() => setOpen(open === x.id ? null : x.id)}>
                      <span className="method">{x.method}{x.tool ? <b> {x.tool}</b> : null}</span>
                      <span className="meta">{x.speaker ? `${x.speaker} · ` : ""}turn {x.turn} · {x.status} · {x.ms} ms</span>
                    </button>
                    {x.method === "initialize" && res?.result && <div className="ex-note">protocolVersion <b>{res.result.protocolVersion}</b> · server {res.result.serverInfo?.name} {res.result.serverInfo?.version}</div>}
                    {sc?.error && <div className="ex-note">Refused by rule <b>{sc.error}</b>: {sc.message}</div>}
                    {open === x.id && (
                      <pre>{JSON.stringify({ request: x.request, response: x.response }, null, 2)}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "chat" && (
            <div className="chat">
              {lines.length === 0 && <p className="hint">Nothing said yet.</p>}
              {lines.map((l, i) => (
                <div key={i} className={"line " + l.kind}><span>{l.who}</span><p>{l.text}</p></div>
              ))}
              <div ref={transcriptEnd} />
            </div>
          )}

          {tab === "house" && house && (
            <div className="house">
              <p className="hint">{house.dataNotice} Read from the MCP resource renewwise://household.</p>
              <h3>Subscriptions</h3>
              <table>
                <thead><tr><th>Service</th><th>Plan</th><th>Status</th><th>Renews</th></tr></thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}<small>{s.usageSource}</small></td>
                      <td>{s.plan.name}<small>{money(s.plan.priceCents)}/{s.plan.period === "year" ? "yr" : "mo"}</small></td>
                      <td><span className={"pill " + s.status}>{s.status.replace("_", " ")}</span>{s.scheduled && <small>{s.scheduled.kind.replace("_", " ")} on {s.scheduled.effectiveDate}</small>}</td>
                      <td>{s.status === "canceled" || s.status === "refunded" ? "Never" : s.nextRenewal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Reminders</h3>
              {house.reminders.length ? house.reminders.map((r: any) => <p key={r.id} className="row">{r.dueDate} · {r.note} <span className={"pill " + r.status}>{r.status}</span></p>) : <p className="row muted">None</p>}
              <h3>Change log</h3>
              {house.ledger.length ? [...house.ledger].reverse().map((l: any) => (
                <p key={l.id} className="row">{l.date} · {l.kind.replace(/_/g, " ")} · {l.detail}{l.confirmedBy !== "system" ? ` · confirmed by ${l.confirmedBy}` : ""}{l.undone ? " · undone" : ""}</p>
              )) : <p className="row muted">No changes yet</p>}
            </div>
          )}
        </aside>
      </main>

      <footer className="foot-note">
        Fictional family, fictional streaming brands, simulated watch history. No real accounts or payments are touched. RenewWise is not affiliated with Amazon.
      </footer>
    </div>
  );
}
