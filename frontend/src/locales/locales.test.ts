import { en as hankoEnglish } from "@teamhanko/hanko-elements/i18n/en";
import { describe, expect, it } from "vitest";
import hankoSlovenian from "../auth/hanko-translations/sl.json";

const files = import.meta.glob<Record<string, unknown>>("./*/*.json", {
  eager: true,
  import: "default",
});

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") {
      flatten(child, path).forEach((text, childPath) => result.set(childPath, text));
    } else {
      result.set(path, String(child));
    }
  }
  return result;
}

function placeholders(text: string): string[] {
  return (text.match(/\{\{?\s*\w+\s*\}?\}/g) ?? []).sort();
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Languages have different plural forms, so `count_one`/`count_other` in English can be right
 * next to `count_one`/`count_two`/`count_few`/`count_other` in Slovenian. Such a key counts as
 * one key `count` (compared by its `_other` text), plus a check that it has exactly the
 * forms its language uses. A suffix without an `_other` form is an ordinary key.
 */
function pluralKeys(texts: Map<string, string>, language: string): Map<string, string> {
  const required = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const result = new Map<string, string>();
  for (const [key, text] of texts) {
    const base = key.replace(PLURAL_SUFFIX, "");
    if (base === key || !texts.has(`${base}_other`)) {
      result.set(key, text);
      continue;
    }
    const forms = [...texts.keys()].filter((other) => other.replace(PLURAL_SUFFIX, "") === base);
    expect(forms.sort(), `plural forms of ${base} in ${language}`).toEqual(
      required.map((category) => `${base}_${category}`).sort(),
    );
    expect(text, `${key} is empty`).not.toBe("");
    expect(placeholders(text), `placeholders of ${key}`).toEqual(
      placeholders(texts.get(`${base}_other`)!),
    );
    result.set(base, texts.get(`${base}_other`)!);
  }
  return result;
}

function expectSameShape(reference: unknown, translation: unknown, language: string) {
  const expected = pluralKeys(flatten(reference), "en");
  const actual = pluralKeys(flatten(translation), language);
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [key, text] of expected) {
    expect(placeholders(actual.get(key)!), `placeholders of ${key}`).toEqual(placeholders(text));
    expect(actual.get(key), `${key} is empty`).not.toBe("");
  }
}

describe("translations", () => {
  const paths = Object.keys(files);
  const languages = [...new Set(paths.map((path) => path.split("/")[1]))];
  const namespaces = [...new Set(paths.map((path) => path.split("/")[2]))];

  it("includes the languages required at launch", () => {
    expect(languages).toEqual(expect.arrayContaining(["en", "sl"]));
  });

  for (const language of languages.filter((name) => name !== "en")) {
    for (const namespace of namespaces) {
      it(`${language}/${namespace} matches English`, () => {
        expectSameShape(files[`./en/${namespace}`], files[`./${language}/${namespace}`], language);
      });
    }
  }

  it("the Slovenian Hanko translation covers everything in Hanko's English", () => {
    const expected = flatten(hankoEnglish);
    const actual = flatten(hankoSlovenian);
    expect([...expected.keys()].filter((key) => !actual.has(key))).toEqual([]);
    for (const [key, text] of expected) {
      expect(placeholders(actual.get(key)!), `placeholders of ${key}`).toEqual(placeholders(text));
    }
  });
});
