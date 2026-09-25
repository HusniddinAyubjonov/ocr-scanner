import type { Line, Page, Word } from "tesseract.js"

const ENGLISH_LABEL_WORDS = new Set([
  "surname",
  "given",
  "names",
  "name",
  "fathers",
  "father",
  "sex",
  "nationality",
  "citizenship",
  "date",
  "of",
  "birth",
  "place",
  "issue",
  "expiry",
  "document",
  "id",
  "no",
  "number",
  "national",
  "authority",
  "address",
  "marital",
  "status",
  "blood",
  "group",
  "and",
  "rh",
  "factor",
  "holder",
  "signature",
  "tax",
  "payer",
  "republic",
  "tajikistan",
  "identity",
  "card",
])
export const isEnglishLabelText = (text: string): boolean => {
  const words = text
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean)
    .map((word) => word.replace(/'/g, ""))
  return (
    words.length > 0 && words.every((word) => ENGLISH_LABEL_WORDS.has(word))
  )
}

const SHORT_WORD_LENGTH = 3
const MIN_LABEL_CONFIDENCE = 50
const MIN_SHORT_LABEL_CONFIDENCE = 80

const overlap = (
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number =>
  Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) /
  Math.max(1, Math.min(endA - startA, endB - startB))

const sameSpot = (first: Word, second: Word): boolean =>
  overlap(first.bbox.y0, first.bbox.y1, second.bbox.y0, second.bbox.y1) >=
    0.5 &&
  overlap(first.bbox.x0, first.bbox.x1, second.bbox.x0, second.bbox.x1) >= 0.5

const englishLabelWord = (word: Word): boolean => {
  const letters = word.text.toLowerCase().replace(/[^a-z]/g, "")
  if (!ENGLISH_LABEL_WORDS.has(letters)) return false
  return (
    word.confidence >=
    (letters.length <= SHORT_WORD_LENGTH
      ? MIN_SHORT_LABEL_CONFIDENCE
      : MIN_LABEL_CONFIDENCE)
  )
}

const pageWords = (page: Page): Word[] =>
  (page.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap((line) => line.words),
    ),
  )

export const mergeEnglishLabels = (tajik: Page, english: Page): Page => {
  if (!tajik.blocks) return tajik
  const labels = pageWords(english).filter(englishLabelWord)
  const placed = new Set<Word>()
  const mergeLine = (line: Line): Line => {
    const words: Word[] = []
    for (const word of line.words) {
      const label = labels.find((candidate) => sameSpot(word, candidate))
      if (!label) {
        words.push(word)
        continue
      }
      if (placed.has(label)) continue
      placed.add(label)
      words.push({ ...word, text: label.text, confidence: label.confidence })
    }
    return {
      ...line,
      words,
      text: `${words.map((word) => word.text).join(" ")}\n`,
    }
  }
  const blocks = tajik.blocks
    .map((block) => ({
      ...block,
      paragraphs: block.paragraphs
        .map((paragraph) => ({
          ...paragraph,
          lines: paragraph.lines
            .map(mergeLine)
            .filter((line) => line.words.length),
        }))
        .filter((paragraph) => paragraph.lines.length),
    }))
    .filter((block) => block.paragraphs.length)
  return { ...tajik, blocks }
}
