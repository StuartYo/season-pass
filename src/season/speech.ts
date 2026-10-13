// Turning numbers and dates into words Alexa can say. Voice text must never contain symbols like $ % | * #.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function screenMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function spokenMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const c = abs % 100;
  if (dollars === 0 && c === 0) return "nothing";
  const d = dollars === 1 ? "1 dollar" : `${dollars} dollars`;
  if (c === 0) return d;
  if (dollars === 0) return `${c} cents`;
  return `${d} and ${c} cents`;
}

function parse(date: string): Date {
  return new Date(date + "T12:00:00Z");
}

export function spokenDate(date: string): string {
  const d = parse(date);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function shortDate(date: string): string {
  const d = parse(date);
  return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000);
}

export function relativeDay(today: string, date: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** Last line of defence: strip characters a speech engine would read out loud or choke on. */
export function cleanSpeech(text: string): string {
  return text
    .replace(/\$(\d+)\.(\d{2})/g, (_m, d, c) => spokenMoney(Number(d) * 100 + Number(c)))
    .replace(/\$(\d+)/g, (_m, d) => spokenMoney(Number(d) * 100))
    .replace(/(\d+)\s?%/g, "$1 percent")
    .replace(/[|*#_`~<>{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
