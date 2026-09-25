import type { Line, Page, Word } from "tesseract.js"

// Every label on the card is printed twice, "Нишонӣ / Address". The Tajik
// model reads the English half as Cyrillic lookalikes and is often confident
// about it ("Name" comes out as "Нате" at 92%), so confidence alone can't
// tell which model to trust. The English labels are a small fixed vocabulary
// though, and the English model reads them exactly, while it never reads a
// genuine Tajik word as one of them. Where it does, the English word replaces
// the garbled one, so the label parsers see clean labels in both languages
// and no leftover garbage that could pass for a field value.
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
// True for text made only of words from the card's printed English labels
// ("of", "Place of birth"): a label fragment, never a field's value.
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
      // A garbled word can be split in two; the English word goes in once.
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
