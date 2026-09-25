import { parse as parseMrz } from "mrz"
import type { Bbox, Page } from "tesseract.js"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"

type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

export type MrzNames = { surname?: string; givenNames?: string }

export type MrzResult = {
  fields: FieldMap
  // Latin names from line 3. They are evidence for the Tajik (Cyrillic)
  // names, never shown as field values themselves.
  names: MrzNames
  // Check-digit based quality of the read, used to choose between OCR passes.
  score: number
  lines: string[]
}

const MRZ_LINE_LENGTH = 30
const OPTIONAL_START = 15
const NATIONAL_ID_LENGTH = 13
const EXPECTED_STATE = "TJK"
const WEIGHTS = [7, 3, 1]

const characterValue = (character: string): number => {
  if (character >= "0" && character <= "9") return Number(character)
  if (character === "<") return 0
  return character.charCodeAt(0) - 55
}

const checkDigit = (value: string): string =>
  String(
    [...value].reduce(
      (sum, character, index) =>
        sum + characterValue(character) * WEIGHTS[index % 3],
      0,
    ) % 10,
  )

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  D: "0",
  Q: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  B: "8",
}
const LETTER_LOOKALIKES: Record<string, string> = {
  "0": "O",
  "1": "I",
  "2": "Z",
  "5": "S",
  "6": "G",
  "8": "B",
}
// The only single-character sex misreads worth repairing: M read as N/H and
// F read as P/E. Everything else stays invalid instead of being guessed.
const SEX_LOOKALIKES: Record<string, string> = {
  N: "M",
  H: "M",
  P: "F",
  E: "F",
}

const mapRange = (
  line: string,
  from: number,
  to: number,
  table: Record<string, string>,
): string =>
  [...line]
    .map((character, index) =>
      index >= from && index <= to
        ? (table[character] ?? character)
        : character,
    )
    .join("")

const replaceAt = (line: string, index: number, value: string): string =>
  line.slice(0, index) + value + line.slice(index + 1)

// State codes are three letters; the card only ever carries the issuing
// state, so a one-character misread of it is snapped back.
const snapState = (code: string): string => {
  const letters = mapRange(code, 0, 2, LETTER_LOOKALIKES)
  const differences = [...EXPECTED_STATE].filter(
    (character, index) => letters[index] !== character,
  ).length
  return differences <= 1 ? EXPECTED_STATE : letters
}

// TD1 line 1: document code (0-1), state (2-4), document number (5-13) and
// its check digit (14). The number is one letter plus eight digits.
const repairLine1 = (line: string): string => {
  let repaired = mapRange(line, 6, 14, DIGIT_LOOKALIKES)
  repaired =
    repaired.slice(0, 2) + snapState(repaired.slice(2, 5)) + repaired.slice(5)
  return repaired
}

// TD1 line 2: birth date (0-5) + check (6), sex (7), expiry (8-13) + check
// (14), nationality (15-17), optional data, composite check (29).
const repairLine2 = (line: string): string => {
  let repaired = mapRange(
    mapRange(line, 0, 6, DIGIT_LOOKALIKES),
    8,
    14,
    DIGIT_LOOKALIKES,
  )
  repaired =
    repaired.slice(0, 15) +
    snapState(repaired.slice(15, 18)) +
    repaired.slice(18)
  const sex = repaired[7]
  if (!/[MF<]/.test(sex) && SEX_LOOKALIKES[sex])
    repaired = replaceAt(repaired, 7, SEX_LOOKALIKES[sex])
  return repaired
}

// "<" filler is what OCR misreads most, usually as one of these letters.
const FILLER_LOOKALIKES = "KLCESIX"
const FILLER_RUN = new RegExp(`[${FILLER_LOOKALIKES}<]{4,}$`)

// A separator is often read with a letter wedged between its chevrons
// ("RUZYEVA<K<MUNISA" for "RUZYEVA<<MUNISA"). A letter with a chevron on both
// sides is never part of a name.
const WEDGED_FILLER = new RegExp(`<[${FILLER_LOOKALIKES}]+(?=<)`, "g")

const repairLine3 = (line: string): string => {
  const trimmed = line
    .replace(WEDGED_FILLER, (run) => "<".repeat(run.length))
    .replace(FILLER_RUN, (run) => "<".repeat(run.length))
  return trimmed.slice(0, MRZ_LINE_LENGTH).padEnd(MRZ_LINE_LENGTH, "<")
}

const scoreLine1 = (line: string): number =>
  (checkDigit(line.slice(5, 14)) === line[14] ? 4 : 0) +
  (/^[ACI][A-Z<]/.test(line) ? 1 : 0) +
  (/^[A-Z]{3}$/.test(line.slice(2, 5)) ? 1 : 0) +
  (line.slice(2, 5) === EXPECTED_STATE ? 2 : 0) +
  (/^[A-Z][0-9]{8}$/.test(line.slice(5, 14)) ? 1 : 0)

const scoreLine2 = (line: string): number =>
  (/^\d{6}$/.test(line.slice(0, 6)) && checkDigit(line.slice(0, 6)) === line[6]
    ? 4
    : 0) +
  (/^[MF<]$/.test(line[7]) ? 1 : 0) +
  (/^\d{6}$/.test(line.slice(8, 14)) &&
  checkDigit(line.slice(8, 14)) === line[14]
    ? 4
    : 0) +
  (/^[A-Z]{3}$/.test(line.slice(15, 18)) ? 1 : 0) +
  (line.slice(15, 18) === EXPECTED_STATE ? 2 : 0)

// OCR drops or adds characters, and a shifted line breaks every field after
// the shift. Every way of inserting "<" (or deleting a character) up to two
// edits is tried and the candidate whose check digits pass wins.
const lengthCandidates = (line: string): string[] => {
  const difference = line.length - MRZ_LINE_LENGTH
  if (difference === 0) return [line]
  if (difference > 2) return [line.slice(0, MRZ_LINE_LENGTH)]
  if (difference < -2) return [line.padEnd(MRZ_LINE_LENGTH, "<")]
  const candidates = new Set<string>()
  if (difference < 0) {
    const insert = (value: string, remaining: number, from: number) => {
      if (remaining === 0) {
        candidates.add(value)
        return
      }
      for (let index = from; index <= value.length; index += 1)
        insert(
          value.slice(0, index) + "<" + value.slice(index),
          remaining - 1,
          index,
        )
    }
    insert(line, -difference, 0)
  } else {
    const remove = (value: string, remaining: number, from: number) => {
      if (remaining === 0) {
        candidates.add(value)
        return
      }
      for (let index = from; index < value.length; index += 1)
        remove(
          value.slice(0, index) + value.slice(index + 1),
          remaining - 1,
          index,
        )
    }
    remove(line, difference, 0)
  }
  return [...candidates]
}

const bestAlignment = (
  line: string,
  repair: (candidate: string) => string,
  score: (candidate: string) => number,
): string => {
  const candidates = lengthCandidates(line)
  let best = repair(candidates[0])
  let bestScore = -1
  for (const candidate of candidates) {
    const repaired = repair(candidate)
    const candidateScore = score(repaired)
    if (candidateScore > bestScore) {
      best = repaired
      bestScore = candidateScore
    }
  }
  return best
}

const cleanLines = (text: string): string[] => {
  const lines = text
    .toUpperCase()
    .split("\n")
    .map((line) => line.replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 24)
  // A block read without line breaks arrives as one 90-character string.
  if (lines.length === 1 && lines[0].length >= 84 && lines[0].length <= 96)
    return [0, 1, 2].map((index) =>
      lines[0].slice(index * MRZ_LINE_LENGTH, (index + 1) * MRZ_LINE_LENGTH),
    )
  return lines.filter((line) => line.length <= 36)
}

type Attempt = { lines: string[]; score: number }

const alignWindow = (window: string[]): Attempt => {
  const line1 = bestAlignment(window[0], repairLine1, scoreLine1)
  const line2 = bestAlignment(window[1], repairLine2, scoreLine2)
  const line3 = repairLine3(window[2])
  return {
    lines: [line1, line2, line3],
    score: scoreLine1(line1) + scoreLine2(line2),
  }
}

const formatMrzDate = (
  value: string | null | undefined,
  expiry: boolean,
): string | null => {
  if (!value || !/^\d{6}$/.test(value)) return null
  const shortYear = Number(value.slice(0, 2))
  const month = Number(value.slice(2, 4))
  const day = Number(value.slice(4, 6))
  const currentShortYear = new Date().getFullYear() % 100
  const year = expiry
    ? 2000 + shortYear
    : shortYear > currentShortYear
      ? 1900 + shortYear
      : 2000 + shortYear
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`
    : null
}

const cleanName = (value: string): string =>
  value.replace(/<+/g, " ").replace(/\s+/g, " ").trim()

const NAME_PATTERN = /^[A-Z][A-Z -]{1,}$/

export const parseMrzText = (text: string): MrzResult | null => {
  const lines = cleanLines(text)
  if (lines.length < 3) return null
  let best: Attempt | null = null
  for (let index = 0; index + 3 <= lines.length; index += 1) {
    const attempt = alignWindow(lines.slice(index, index + 3))
    if (!best || attempt.score > best.score) best = attempt
  }
  if (!best) return null
  let result: ReturnType<typeof parseMrz>
  try {
    result = parseMrz(best.lines, { autocorrect: true })
  } catch {
    return null
  }
  const valid = (name: string): boolean =>
    result.details.some((detail) => detail.field === name && detail.valid)
  const documentOk = valid("documentNumberCheckDigit")
  const birthOk = valid("birthDateCheckDigit")
  const expiryOk = valid("expirationDateCheckDigit")
  const compositeOk = valid("compositeCheckDigit")
  const checksPassed = [documentOk, birthOk, expiryOk].filter(Boolean).length
  const score = best.score + (compositeOk ? 4 : 0)
  // One passing check digit is 90% evidence at best (a random misread passes
  // 1 time in 10), so the check-digit-guarded fields need a second one, or
  // the composite digit, to agree before they are trusted.
  const datesTrusted = checksPassed >= 2 || compositeOk
  if (checksPassed === 0)
    return { fields: {}, names: {}, score, lines: best.lines }

  // Sex, nationality and names have no check digit of their own, so they
  // inherit trust from how much of the surrounding lines verified.
  const checked = compositeOk || checksPassed === 3 ? 98 : 92
  const unchecked = compositeOk ? 92 : checksPassed >= 2 ? 82 : 65
  const fields: FieldMap = {}
  const set = (
    key: IdCardFieldKey,
    value: string | null | undefined,
    fieldConfidence: number,
  ) => {
    if (value)
      fields[key] = { value, confidence: fieldConfidence, source: "mrz" }
  }
  const mrz = result.fields
  if (datesTrusted) {
    if (documentOk && /^[A-Z0-9]{6,9}$/.test(mrz.documentNumber ?? ""))
      set("documentNumber", mrz.documentNumber, checked)
    if (birthOk) set("birthDate", formatMrzDate(mrz.birthDate, false), checked)
    if (expiryOk)
      set("expiryDate", formatMrzDate(mrz.expirationDate, true), checked)
  }
  if (mrz.sex === "male") set("sex", "M", unchecked)
  if (mrz.sex === "female") set("sex", "F", unchecked)
  if (/^[A-Z]{3}$/.test(mrz.nationality ?? ""))
    set("citizenship", mrz.nationality, unchecked)
  // Tajik cards carry the national ID number in the optional data of line 1.
  // It shares the composite check digit with the rest of the line, and the
  // document number's own check digit vouches for where the line is aligned.
  if (documentOk || compositeOk) {
    const optional = mapRange(
      best.lines[0].slice(OPTIONAL_START, OPTIONAL_START + NATIONAL_ID_LENGTH),
      0,
      NATIONAL_ID_LENGTH - 1,
      DIGIT_LOOKALIKES,
    )
    if (new RegExp(`^\\d{${NATIONAL_ID_LENGTH}}$`).test(optional))
      set("nationalIdNumber", optional, unchecked)
  }

  const names: MrzNames = {}
  const surname = cleanName(mrz.lastName ?? "")
  const givenNames = cleanName(mrz.firstName ?? "")
  if (NAME_PATTERN.test(surname)) names.surname = surname
  if (NAME_PATTERN.test(givenNames)) names.givenNames = givenNames
  return { fields, names, score, lines: best.lines }
}

// Where the MRZ lines are on the image, top to bottom, for registering the
// rest of the card against them. Only lines that look like MRZ lines count;
// with more than three, the bottom three are the MRZ.
export const mrzLineBoxes = (page: Page): Bbox[] => {
  const lines = (page.blocks ?? [])
    .flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines),
    )
    .filter((line) => {
      const cleaned = line.text.toUpperCase().replace(/[^A-Z0-9<]/g, "")
      return cleaned.length >= 24 && cleaned.length <= 36
    })
    .map((line) => line.bbox)
    .sort((first, second) => first.y0 - second.y0)
  return lines.slice(-3)
}
