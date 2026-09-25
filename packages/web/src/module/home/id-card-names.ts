import type { Bbox, Page } from "tesseract.js"
import { editDistance, namesAgree } from "./id-card.utils"
import type { MrzNames } from "./id-card-mrz"
import type { RecognizedField } from "./id-card-recognition"

export type NameField = "surname" | "givenNames" | "fatherName"
export const NAME_FIELDS: NameField[] = ["surname", "givenNames", "fatherName"]

type NameFieldMap = Partial<Record<NameField, RecognizedField>>

export type OcrLine = { text: string; confidence: number; bbox: Bbox }

// Everything one card side tells us about the three names. The card prints
// each name twice — Tajik Cyrillic, then its Latin transliteration right
// under it — and the MRZ carries the Latin surname and given names again.
// The Tajik model reads Cyrillic and the English model reads Latin, so the
// Latin readings are what proves (and repairs) the Cyrillic ones.
export type NameEvidence = {
  cyrillic: OcrLine[]
  latin: OcrLine[]
  labeled: NameFieldMap
  mrz: MrzNames
}

const CYRILLIC_LETTERS = "АБВГҒДЕЁЖЗИӢЙКҚЛМНОПРСТУӮФХҲЦЧҶШЩЪЫЬЭЮЯ"
const CYRILLIC_NAME = new RegExp(
  `^[${CYRILLIC_LETTERS}]{2,}(?:[ '-][${CYRILLIC_LETTERS}]+)*$`,
)
const LATIN_NAME = /^[A-Z]{2,}(?:[ '-][A-Z]+)*$/
const LABEL_TEXT =
  /НАСАБ|^НОМ$|НОМИ|ПАДАР|ША[ҲХ]РВАНД|[ҶЧ]ИНС|ТАВАЛЛУД|МА[ҚК]ОМИ|НИШОН|ШИНОСНОМА|РА[ҚК]АМИ|SURNAME|FATHER|NATIONALITY|BIRTH|AUTHORITY|ADDRESS|DOCUMENT|ISSUE|EXPIRY|^NAME$|^SEX$/

// Each model also "reads" the other script, as lookalike letters. On the same
// physical line the reading in the right language is the far more confident
// one; a line is dropped as a shadow only when it loses by more than this
// margin, and lines closer than that are both kept.
const SHADOW_MARGIN = 8
const MIN_LATIN_CONFIDENCE = 50
const MIN_WORD_CONFIDENCE = 25

const TRANSLIT: Record<string, string> = {
  А: "A",
  Б: "B",
  В: "V",
  Г: "G",
  Ғ: "GH",
  Д: "D",
  Е: "E",
  Ё: "YO",
  Ж: "ZH",
  З: "Z",
  И: "I",
  Ӣ: "I",
  Й: "Y",
  К: "K",
  Қ: "Q",
  Л: "L",
  М: "M",
  Н: "N",
  О: "O",
  П: "P",
  Р: "R",
  С: "S",
  Т: "T",
  У: "U",
  Ӯ: "U",
  Ф: "F",
  Х: "KH",
  Ҳ: "H",
  Ц: "TS",
  Ч: "CH",
  Ҷ: "J",
  Ш: "SH",
  Щ: "SHCH",
  Ъ: "",
  Ы: "Y",
  Ь: "",
  Э: "E",
  Ю: "YU",
  Я: "YA",
}

// Letters the Tajik model mixes up because they differ only by a hook, and
// which the Latin transliteration tells apart (К=K/Қ=Q, Х=KH/Ҳ=H, Г=G/Ғ=GH,
// Ч=CH/Ҷ=J). Ӣ/И and Ӯ/У are absent on purpose: both transliterate the same.
const HOOK_PAIRS: Record<string, string> = {
  К: "Қ",
  Қ: "К",
  Х: "Ҳ",
  Ҳ: "Х",
  Г: "Ғ",
  Ғ: "Г",
  Ч: "Ҷ",
  Ҷ: "Ч",
}
const MAX_HOOK_POSITIONS = 8

const normalizeLine = (text: string): string =>
  text
    .normalize("NFC")
    .toUpperCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .replace(/\s+/g, " ")

const transliterate = (cyrillic: string): string =>
  [...cyrillic].map((character) => TRANSLIT[character] ?? "").join("")

const compactLatin = (latin: string): string => latin.replace(/[^A-Z]/g, "")

const distanceRatio = (first: string, second: string): number =>
  editDistance(first, second) / Math.max(first.length, second.length, 1)

const overlap = (
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number =>
  Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) /
  Math.max(1, Math.min(endA - startA, endB - startB))

const sameLine = (first: OcrLine, second: OcrLine): boolean =>
  overlap(first.bbox.y0, first.bbox.y1, second.bbox.y0, second.bbox.y1) >=
    0.5 &&
  overlap(first.bbox.x0, first.bbox.x1, second.bbox.x0, second.bbox.x1) >= 0.3

export const toOcrLines = (page: Page): OcrLine[] =>
  (page.blocks ?? [])
    .flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines),
    )
    .map((line) => ({
      text: line.words
        .filter((word) => word.confidence >= MIN_WORD_CONFIDENCE)
        .map((word) => word.text)
        .join(" "),
      confidence: line.confidence,
      bbox: line.bbox,
    }))

export const buildNameEvidence = (input: {
  tajikLines: OcrLine[]
  englishLines: OcrLine[]
  labeled: NameFieldMap
  mrz: MrzNames
}): NameEvidence => {
  const cyrillic = input.tajikLines
    .map((line) => ({ ...line, text: normalizeLine(line.text) }))
    .filter(
      (line) => CYRILLIC_NAME.test(line.text) && !LABEL_TEXT.test(line.text),
    )
  const latin = input.englishLines
    .map((line) => ({ ...line, text: normalizeLine(line.text) }))
    .filter(
      (line) =>
        LATIN_NAME.test(line.text) &&
        !LABEL_TEXT.test(line.text) &&
        line.confidence >= MIN_LATIN_CONFIDENCE,
    )
  return {
    cyrillic: cyrillic.filter(
      (line) =>
        !latin.some(
          (other) =>
            sameLine(line, other) &&
            other.confidence > line.confidence + SHADOW_MARGIN,
        ),
    ),
    latin: latin.filter(
      (line) =>
        !cyrillic.some(
          (other) =>
            sameLine(line, other) &&
            other.confidence > line.confidence + SHADOW_MARGIN,
        ),
    ),
    labeled: input.labeled,
    mrz: input.mrz,
  }
}

type Repair = { value: string; ratio: number }

// Tries every hook-letter variant of the Cyrillic reading and keeps the one
// whose transliteration is closest to the Latin readings.
const repairByLatin = (cyrillic: string, anchors: string[]): Repair => {
  const cost = (candidate: string): number =>
    anchors.reduce(
      (sum, anchor) => sum + editDistance(transliterate(candidate), anchor),
      0,
    )
  const ratioOf = (candidate: string): number =>
    anchors.length === 0
      ? 1
      : Math.min(
          ...anchors.map((anchor) =>
            distanceRatio(transliterate(candidate), anchor),
          ),
        )
  const characters = [...cyrillic]
  const positions = characters.flatMap((character, index) =>
    HOOK_PAIRS[character] ? [index] : [],
  )
  if (anchors.length === 0 || positions.length > MAX_HOOK_POSITIONS)
    return { value: cyrillic, ratio: ratioOf(cyrillic) }
  let best = { value: cyrillic, cost: cost(cyrillic), flips: 0 }
  for (let mask = 1; mask < 1 << positions.length; mask += 1) {
    const variant = [...characters]
    let flips = 0
    positions.forEach((position, bit) => {
      if (mask & (1 << bit)) {
        variant[position] = HOOK_PAIRS[characters[position]]
        flips += 1
      }
    })
    const value = variant.join("")
    const variantCost = cost(value)
    if (
      variantCost < best.cost ||
      (variantCost === best.cost && flips < best.flips)
    )
      best = { value, cost: variantCost, flips }
  }
  return { value: best.value, ratio: ratioOf(best.value) }
}

type Pair = { cyrillic: OcrLine; latin?: OcrLine; verified: boolean }

const partnerBelow = (
  cyrillic: OcrLine,
  latin: OcrLine[],
): OcrLine | undefined => {
  const height = Math.max(1, cyrillic.bbox.y1 - cyrillic.bbox.y0)
  return latin
    .filter(
      (line) =>
        line.bbox.y0 >= cyrillic.bbox.y1 - height * 0.4 &&
        line.bbox.y0 <= cyrillic.bbox.y1 + height * 2 &&
        overlap(
          cyrillic.bbox.x0,
          cyrillic.bbox.x1,
          line.bbox.x0,
          line.bbox.x1,
        ) >= 0.3,
    )
    .sort((first, second) => first.bbox.y0 - second.bbox.y0)[0]
}

const agrees = (cyrillic: string, latin: string): boolean =>
  distanceRatio(transliterate(cyrillic), compactLatin(latin)) <= 0.25 ||
  namesAgree(cyrillic, latin)

const buildPairs = (evidence: NameEvidence): Pair[] =>
  evidence.cyrillic
    .map((cyrillic) => {
      const latin = partnerBelow(cyrillic, evidence.latin)
      return {
        cyrillic,
        latin,
        verified: latin ? agrees(cyrillic.text, latin.text) : false,
      }
    })
    .sort((first, second) => first.cyrillic.bbox.y0 - second.cyrillic.bbox.y0)

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)))

const labeledField = (
  field: NameField,
  sides: NameEvidence[],
): RecognizedField | undefined =>
  sides
    .map((side) => side.labeled[field])
    .filter((value): value is RecognizedField => Boolean(value))
    .sort((first, second) => second.confidence - first.confidence)[0]

const MRZ_MATCH_RATIO = 0.3
const UNVERIFIED_MRZ_MATCH_RATIO = 0.2
const LABEL_ONLY_CEILING = 55
const LABEL_ONLY_FLOOR = 40

export const resolveNames = (sides: NameEvidence[]): NameFieldMap => {
  const anchors: MrzNames = {}
  for (const side of sides) {
    anchors.surname ??= side.mrz.surname
    anchors.givenNames ??= side.mrz.givenNames
  }
  const pairsBySide = sides.map(buildPairs)
  const allPairs = pairsBySide.flat()
  const assigned = new Map<NameField, Pair>()
  const used = new Set<Pair>()
  const take = (field: NameField, pair: Pair | undefined) => {
    if (!pair || used.has(pair)) return
    assigned.set(field, pair)
    used.add(pair)
  }

  // 1. The MRZ names are the most trustworthy Latin text on the card, so a
  //    Cyrillic line that transliterates to one of them settles which field
  //    it is, whatever the layout looks like.
  for (const field of ["surname", "givenNames"] as const) {
    const anchor = anchors[field] && compactLatin(anchors[field])
    if (!anchor) continue
    let best: { pair: Pair; ratio: number } | undefined
    for (const pair of allPairs) {
      if (used.has(pair)) continue
      const limit = pair.verified ? MRZ_MATCH_RATIO : UNVERIFIED_MRZ_MATCH_RATIO
      const ratio = Math.min(
        repairByLatin(pair.cyrillic.text, [anchor]).ratio,
        pair.latin ? distanceRatio(compactLatin(pair.latin.text), anchor) : 1,
      )
      if (ratio <= limit && (!best || ratio < best.ratio))
        best = { pair, ratio }
    }
    take(field, best?.pair)
  }

  // 2. A value the label parsers already found under its own label.
  for (const field of NAME_FIELDS) {
    if (assigned.has(field)) continue
    const labeled = normalizeLine(labeledField(field, sides)?.value ?? "")
    if (!labeled) continue
    take(
      field,
      allPairs.find(
        (pair) =>
          !used.has(pair) && editDistance(pair.cyrillic.text, labeled) <= 1,
      ),
    )
  }

  // 3. Reading order. Surname, given name and father's name are stacked in
  //    that order, so the verified pairs of the fullest side fill what is
  //    still open, top to bottom.
  const openFields = NAME_FIELDS.filter((field) => !assigned.has(field))
  const fullestSide =
    pairsBySide
      .map((pairs) => pairs.filter((pair) => pair.verified && !used.has(pair)))
      .sort((first, second) => second.length - first.length)[0] ?? []
  if (openFields.length > 0 && fullestSide.length >= openFields.length) {
    const anchoredAbove = NAME_FIELDS.filter((field) => assigned.has(field))
    // Only trust the order when what is left is exactly what is open, or
    // when nothing is assigned yet and the card shows all three names.
    if (
      fullestSide.length === openFields.length ||
      (anchoredAbove.length === 0 && fullestSide.length >= 3)
    )
      openFields.forEach((field, index) => take(field, fullestSide[index]))
  }

  const result: NameFieldMap = {}
  for (const field of NAME_FIELDS) {
    const pair = assigned.get(field)
    if (pair) {
      const latinAnchors = [
        ...(field !== "fatherName" && anchors[field]
          ? [compactLatin(anchors[field])]
          : []),
        ...(pair.latin ? [compactLatin(pair.latin.text)] : []),
      ]
      const lineConfidence = pair.cyrillic.confidence
      // Nothing Latin to compare with: found by its label only, not verified.
      if (latinAnchors.length === 0) {
        result[field] = {
          value: pair.cyrillic.text,
          confidence: clamp(
            lineConfidence,
            LABEL_ONLY_FLOOR,
            LABEL_ONLY_CEILING,
          ),
          source: "layout",
        }
        continue
      }
      const repair = repairByLatin(pair.cyrillic.text, latinAnchors)
      result[field] = {
        value: repair.value,
        confidence:
          repair.ratio === 0
            ? clamp(lineConfidence, 88, 97)
            : repair.ratio <= 0.2
              ? clamp(lineConfidence, 72, 88)
              : clamp(lineConfidence, 60, 78),
        source: "verified",
      }
      continue
    }
    const labeled = labeledField(field, sides)
    if (labeled)
      result[field] = {
        ...labeled,
        confidence: clamp(
          labeled.confidence,
          LABEL_ONLY_FLOOR,
          LABEL_ONLY_CEILING,
        ),
      }
  }
  return result
}
