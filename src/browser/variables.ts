// Values a step needs but the model never sees. A step says "fill %email%";
// the model is told a variable called email exists (and what it is for), puts
// the placeholder in its answer, and the value goes in only when the driver
// types it. So a routine can be recorded once and run for anyone, and a
// secret reaches the page without passing through a prompt or a log.

export type VariableValue = string | { value: string; secret?: boolean; description?: string };
export type Variables = Record<string, VariableValue>;

/** What a routine says about a variable it needs; never its value. */
export interface VariableSpec {
  name: string;
  description?: string;
  secret?: boolean;
}

const PLACEHOLDER = /%([A-Za-z_][\w-]*)%/g;

export const valueOf = (v: VariableValue): string => (typeof v === "string" ? v : v.value);
export const isSecretVar = (v: VariableValue | undefined): boolean => typeof v === "object" && v !== null && v.secret === true;

/** The variable names a text mentions. */
export const placeholdersIn = (...texts: string[]): string[] => [...new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1])))];

/** Put the values in. Unknown names are left as written and reported. */
export const substitute = (text: string, vars: Variables = {}): { text: string; secret: boolean; missing: string[] } => {
  let secret = false;
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      missing.push(name);
      return whole;
    }
    if (isSecretVar(v)) secret = true;
    return valueOf(v);
  });
  return { text: out, secret, missing };
};

/** Turn literal values back into placeholders: a routine recorded with real
 *  values becomes one that runs for any. Longest values first, so one value
 *  inside another is not split. */
export const parameterize = (text: string, literals: Record<string, string>): string => {
  let out = text;
  for (const [name, value] of Object.entries(literals).sort((a, b) => b[1].length - a[1].length)) {
    if (value) out = out.split(value).join(`%${name}%`);
  }
  return out;
};

/** The variables as the model is told about them: names and purposes only. */
export const describeVariables = (vars: Variables | VariableSpec[] = {}): string => {
  const specs: VariableSpec[] = Array.isArray(vars)
    ? vars
    : Object.entries(vars).map(([name, v]) => ({ name, ...(typeof v === "object" ? { description: v.description, secret: v.secret } : {}) }));
  return specs.map((s) => `%${s.name}%${s.description ? ` (${s.description})` : ""}`).join(", ");
};
