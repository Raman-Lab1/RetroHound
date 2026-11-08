// Sigma condition grammar, hand-written recursive descent. Loosest to tightest: or, and, not, `x of`, parens.
import { allOf, anyOf, RuleError, type Pred } from "./modifiers.ts";

const KEYWORDS = new Set(["and", "or", "not", "of", "them"]);
const WORD = /^[A-Za-z0-9_*-]+$/;

function tokenize(cond: string): string[] {
  if (cond.includes("|")) throw new RuleError("condition-aggregation", `'${cond}': '|' aggregation is obsolete, use a correlation rule`);
  const tokens = cond.match(/[()]|[A-Za-z0-9_*-]+|\S/g) ?? [];
  const bad = tokens.find((t) => t !== "(" && t !== ")" && !WORD.test(t));
  if (bad) throw new RuleError("condition-syntax", `'${cond}': unexpected '${bad}'`);
  return tokens;
}

/** The selections a pattern or `them` covers. `_` ids stay out unless the pattern itself starts with `_`. */
function expand(cond: string, target: string, ids: string[]): string[] {
  const re = new RegExp(`^${target === "them" ? ".*" : target.replaceAll("*", ".*")}$`);
  const hits = ids.filter((id) => re.test(id) && (target.startsWith("_") || !id.startsWith("_")));
  if (hits.length === 0) throw new RuleError("condition-no-selection", `'${cond}': '${target}' matches no selection`);
  return hits;
}

/** Compiles a condition against the rule's named selections. */
export function compileCondition(cond: string, selections: Map<string, Pred>): Pred {
  const tokens = tokenize(cond);
  const syntax = (why: string) => new RuleError("condition-syntax", `'${cond}': ${why}`);
  let pos = 0;

  function orExpr(): Pred {
    let left = andExpr();
    while (tokens[pos] === "or") {
      pos++;
      const a = left;
      const b = andExpr();
      left = (ev) => a(ev) || b(ev);
    }
    return left;
  }

  function andExpr(): Pred {
    let left = notExpr();
    while (tokens[pos] === "and") {
      pos++;
      const a = left;
      const b = notExpr();
      left = (ev) => a(ev) && b(ev);
    }
    return left;
  }

  function notExpr(): Pred {
    if (tokens[pos] !== "not") return primary();
    pos++;
    const inner = notExpr();
    return (ev) => !inner(ev);
  }

  function primary(): Pred {
    const t = tokens[pos++];
    if (t === undefined) throw syntax("unexpected end");
    if (t === "(") {
      const inner = orExpr();
      if (tokens[pos++] !== ")") throw syntax("missing ')'");
      return inner;
    }
    if ((t === "1" || t === "any" || t === "all") && tokens[pos] === "of") {
      const target = tokens[pos + 1];
      pos += 2;
      if (target === undefined || !WORD.test(target) || (KEYWORDS.has(target) && target !== "them")) throw syntax("'of' needs a pattern or 'them'");
      const preds = expand(cond, target, [...selections.keys()]).map((id) => selections.get(id)!);
      return t === "all" ? allOf(preds) : anyOf(preds);
    }
    if (t === ")" || KEYWORDS.has(t)) throw syntax(`unexpected '${t}'`);
    if (t.includes("*")) throw syntax(`pattern '${t}' needs '1 of' or 'all of'`);
    const pred = selections.get(t);
    if (!pred) throw new RuleError("condition-unknown-selection", `'${cond}': no selection named '${t}'`);
    return pred;
  }

  const result = orExpr();
  if (pos < tokens.length) throw syntax(`unexpected '${tokens[pos]}'`);
  return result;
}
