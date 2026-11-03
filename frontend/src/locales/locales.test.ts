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

function expectSameShape(reference: unknown, translation: unknown) {
  const expected = flatten(reference);
  const actual = flatten(translation);
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
        expectSameShape(files[`./en/${namespace}`], files[`./${language}/${namespace}`]);
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
