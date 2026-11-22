import { Fragment, createContext, useContext, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { FR } from "./fr";

// French / English for the app's own words: navigation, buttons, headings, status words, empty states.
// DECISION: a dictionary keyed by the English text, and one function, t(). No i18n framework: the code still reads in
// English, and a missing translation shows the English instead of a broken key. Sentences the SERVER writes (check
// results, reasons, advice) stay English; translating them means translating the rules' wording in Python too.
// DECISION: "a screen is fully French or not switched at all". Only the screens listed in COVERED switch; on any other
// screen the whole page, menu included, stays English, so no screen is ever half-translated.

export type Lang = "en" | "fr";
const KEY = "harborline:lang";
export const COVERED = [/^\/$/, /^\/inbox/, /^\/approvals/, /^\/payments/];

let current: Lang = "en";   // the language being rendered right now (set by LanguageProvider before its children render)
const missing = new Set<string>();

export function lang(): Lang {
  return current;
}

/** "Payments" → "Paiements" when French is on. `{name}` placeholders are filled from `vars`. */
export function t(english: string, vars?: Record<string, string | number>): string {
  // "Paid|payment" = "Paid" said of a payment: French needs it ("payé") apart from an invoice ("payée"). English drops it.
  let out = english.split("|")[0];
  if (current === "fr") {
    if (FR[english] !== undefined) out = FR[english];
    else if (!missing.has(english)) {
      missing.add(english);
      // e2e/i18n.mjs reads this list: every word on a French screen must have its translation.
      (window as unknown as { __i18nMissing?: string[] }).__i18nMissing = [...missing];
    }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : out;
}

type Ctx = { chosen: Lang; shown: Lang; covered: boolean; choose: (l: Lang) => void };
const LangContext = createContext<Ctx>({ chosen: "en", shown: "en", covered: true, choose: () => {} });
export const useLang = () => useContext(LangContext);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [chosen, setChosen] = useState<Lang>(() => {
    try { return localStorage.getItem(KEY) === "fr" ? "fr" : "en"; } catch { return "en"; }
  });
  const covered = COVERED.some((r) => r.test(pathname));
  const shown: Lang = chosen === "fr" && covered ? "fr" : "en";
  current = shown;   // set during render, before the children render: every t() below reads it
  const choose = (l: Lang) => {
    try { localStorage.setItem(KEY, l); } catch { /* private window: the choice lasts until reload */ }
    setChosen(l);
  };
  return (
    <LangContext.Provider value={{ chosen, shown, covered, choose }}>
      {/* Keyed by language: switching re-renders every screen in the new language (a toggle is rare, so a remount
          and a refetch are cheap). */}
      <Fragment key={shown}>{children}</Fragment>
    </LangContext.Provider>
  );
}

/** EN | FR in the sidebar; on a phone, one small button that switches to the other language. On a screen that
 *  isn't translated, it says so. */
export function LanguageSwitch({ compact }: { compact?: boolean }) {
  const { chosen, covered, choose } = useLang();
  if (compact) {
    const other: Lang = chosen === "fr" ? "en" : "fr";
    return (
      <button className="lang-toggle" onClick={() => choose(other)} lang={other}
        aria-label={other === "fr" ? "Français" : "English"}>{other.toUpperCase()}</button>
    );
  }
  return (
    <div className="lang-switch">
      <div className="lang-buttons" role="group" aria-label="Language / Langue">
        {(["en", "fr"] as const).map((l) => (
          <button key={l} aria-pressed={chosen === l} className={chosen === l ? "on" : ""} onClick={() => choose(l)} lang={l}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      {chosen === "fr" && !covered && <span className="lang-note" lang="fr">Page en anglais seulement</span>}
    </div>
  );
}
