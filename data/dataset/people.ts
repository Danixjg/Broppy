// The colleagues around the six personas: fictional, ASCII names, each in one or two teams. Contractors belong to no
// team, so they reach an item only when it names them.
import { Rng, byCode, sortedUnique } from "./random.js";
import { PERSONAS, PERSONA_GROUPS, type PersonaId, type Scale } from "./rules.js";

export interface Person {
  name: string;
  first: string;
  email: string;
  teams: string[];
  contractor: boolean;
  persona?: PersonaId;
}

const FIRST_NAMES = [
  "Lena", "Tomas", "Priya", "Jonas", "Amara", "Kenji", "Sofia", "Mateo", "Ingrid", "Kwame", "Hana", "Oskar", "Leila",
  "Diego", "Freya", "Yuki", "Nadia", "Felix", "Zara", "Emeka", "Clara", "Arjun", "Tariq", "Elena", "Bruno", "Aisha",
  "Lukas", "Ines", "Omar", "Greta", "Hugo", "Selin", "Pavel", "Rosa", "Idris", "Maren", "Theo", "Anika", "Jamal",
  "Lucia", "Viktor", "Esther", "Femi", "Astrid", "Marco", "Chiara", "Samir", "Talia", "Bjorn", "Keiko", "Andre", "Lina",
  "Rafael", "Dmitri", "Ayla", "Gustav", "Imani", "Leon", "Nikolai", "Paloma", "Ruben", "Sana", "Tobias", "Vera", "Wren",
  "Yara", "Zeno", "Ada", "Bastian", "Celine", "Dario", "Elif"
];
const LAST_NAMES = [
  "Okafor", "Ferreira", "Lindqvist", "Mensah", "Tanaka", "Rossi", "Alvarez", "Berg", "Owusu", "Novak", "Haddad",
  "Moreno", "Larsen", "Mehta", "Sato", "Petrov", "Ibrahim", "Fischer", "Costa", "Dubois", "Kowalski", "Nakamura",
  "Oyelaran", "Silva", "Weber", "Yilmaz", "Andersen", "Bianchi", "Dias", "Eriksen", "Garcia", "Hoffmann", "Ito",
  "Jensen", "Kaplan", "Lopez", "Murphy", "Nilsson", "Ortiz", "Quinn", "Reyes", "Schmidt", "Torres", "Ueda", "Varga",
  "Walsh", "Abara", "Brandt", "Castillo", "Duarte", "Engel", "Fontaine", "Holm", "Iyer", "Juarez", "Keller", "Lund",
  "Moretti", "Nowak", "Pereira", "Rahman", "Strand", "Toivonen", "Vidal", "Wagner", "Zimmer"
];

/** Staff colleagues at demo scale, as [team, second team?]: 55 people. */
const STAFF_SLOTS: Array<[string, string?]> = [
  ["platform", "eng-leads"], ["platform", "eng-leads"], ["platform", "sre"], ["platform"], ["platform"], ["platform"],
  ["platform"], ["platform"], ["platform"],
  ["sre", "eng-leads"], ["sre"], ["sre"], ["sre"], ["sre"],
  ["mobile", "eng-leads"], ["mobile", "design"], ["mobile"], ["mobile"], ["mobile"], ["mobile"], ["mobile"],
  ["data", "eng-leads"], ["data", "product"], ["data"], ["data"], ["data"], ["data"],
  ["product", "finance"], ["product", "design"], ["product"], ["product"], ["product"], ["product"],
  ["design"], ["design"], ["design"], ["design"],
  ["risk", "legal"], ["risk"], ["risk"], ["risk"],
  ["legal"], ["legal"], ["legal"],
  ["people-ops"], ["people-ops"], ["people-ops"],
  ["finance"], ["finance"], ["finance"], ["finance"],
  ["interns"], ["interns"], ["interns"], ["interns"]
];
const DEMO_CONTRACTORS = 5;

export class People {
  readonly staff: Person[];
  readonly contractors: Person[];
  readonly personas: Person[];
  /** Every employee: staff colleagues and the five staff personas, never a contractor. */
  readonly everyone: string[];
  readonly mentors: [Person, Person];
  readonly interns: Person[];
  private readonly byEmail = new Map<string, Person>();

  constructor(rng: Rng, scale: Scale) {
    const copies = scale === "brief" ? 10 : 1;
    const slots = Array.from({ length: copies }, () => STAFF_SLOTS).flat();
    const names = uniqueNames(rng.stream("names"), slots.length + DEMO_CONTRACTORS * copies);
    this.staff = slots.map(([team, second], index) => person(names[index], second ? [team, second] : [team], false));
    this.contractors = names.slice(slots.length).map(name => person(name, [], true));
    this.personas = PERSONAS.map(user => ({
      name: user.name,
      first: user.name.split(" ")[0],
      email: user.email,
      teams: sortedUnique([...user.groups, ...PERSONA_GROUPS[user.id as PersonaId]]),
      contractor: Boolean(user.contractor),
      persona: user.id as PersonaId
    }));
    for (const item of [...this.staff, ...this.contractors, ...this.personas]) this.byEmail.set(item.email, item);
    this.everyone = sortedUnique([
      ...this.staff.map(item => item.email),
      ...this.personas.filter(item => !item.contractor).map(item => item.email)
    ]);
    const plain = (team: string) => this.staff.filter(item => item.teams.length === 1 && item.teams[0] === team);
    this.mentors = [plain("platform")[0], plain("data")[0]];
    this.interns = this.staff.filter(item => item.teams.includes("interns"));
  }

  persona(id: PersonaId): Person {
    return this.personas.find(item => item.persona === id)!;
  }

  get(email: string): Person | undefined {
    return this.byEmail.get(email);
  }

  private readonly audiences = new Map<string, string[]>();

  /** Staff colleagues and personas in any of the teams. Contractors are never in a team. */
  audience(teams: readonly string[]): string[] {
    if (!teams.length) return [];
    const key = sortedUnique(teams).join(",");
    let found = this.audiences.get(key);
    if (!found) {
      found = sortedUnique([...this.staff, ...this.personas]
        .filter(item => !item.contractor && item.teams.some(team => teams.includes(team)))
        .map(item => item.email));
      this.audiences.set(key, found);
    }
    return found;
  }

  /** Staff colleagues in all of the teams, in a fixed order. */
  members(teams: readonly string[]): Person[] {
    return this.staff.filter(item => teams.every(team => item.teams.includes(team)))
      .sort((a, b) => byCode(a.email, b.email));
  }
}

function person(name: string, teams: string[], contractor: boolean): Person {
  const [first, last] = name.split(" ");
  const domain = contractor ? "contractor.example" : "aspire.example";
  return { name, first, email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`, teams: sortedUnique(teams), contractor };
}

/** Distinct first and last name pairs, with no first name used twice until every first name has been used. */
function uniqueNames(rng: Rng, count: number): string[] {
  const firsts = rng.shuffle(FIRST_NAMES);
  const lasts = rng.shuffle(LAST_NAMES);
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; names.length < count; index++) {
    const first = firsts[index % firsts.length];
    const round = Math.floor(index / firsts.length);
    let offset = 0;
    let name = `${first} ${lasts[(index + round * 7) % lasts.length]}`;
    while (seen.has(name)) name = `${first} ${lasts[(index + round * 7 + ++offset) % lasts.length]}`;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** The people a bank's roles name: distinct colleagues with all the listed teams, rotated per bank for variety. */
export class Cast {
  private readonly people = new Map<string, Person>();

  constructor(private readonly everyone: People, bankKey: string, roles: Record<string, string[]>) {
    const used = new Set<string>();
    const spin = [...bankKey].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    for (const [role, teams] of Object.entries(roles)) {
      const candidates = everyone.members(teams).filter(item => !used.has(item.email));
      if (!candidates.length) throw new Error(`No colleague for role ${role} (${teams.join(", ")}) in ${bankKey}`);
      const chosen = candidates[spin % candidates.length];
      used.add(chosen.email);
      this.people.set(role, chosen);
    }
  }

  /** A role, a persona id, a contractor (c1-c5), a mentor (m1, m2) or an intern (i1-i4). */
  get(role: string): Person {
    const found = this.people.get(role);
    if (found) return found;
    if ((["ravi", "maya", "alex", "david", "nur", "wei"] as string[]).includes(role)) return this.everyone.persona(role as PersonaId);
    const contractor = /^c(\d)$/.exec(role);
    if (contractor) return this.everyone.contractors[Number(contractor[1]) - 1];
    const mentor = /^m(\d)$/.exec(role);
    if (mentor) return this.everyone.mentors[Number(mentor[1]) - 1];
    const intern = /^i(\d)$/.exec(role);
    if (intern) return this.everyone.interns[Number(intern[1]) - 1];
    throw new Error(`Unknown role ${role}`);
  }

  /** Text with {role} placeholders replaced by full names. */
  fill(text: string): string {
    return text.replace(/\{([a-z0-9]+)\}/g, (_, role: string) => this.get(role).name);
  }
}
