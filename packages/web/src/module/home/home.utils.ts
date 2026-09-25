import type { Page } from "tesseract.js"

const MIN_WORD_CONFIDENCE = 25

export const cleanupRecognizedText = (text: string): string =>
  text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(
      (line, index, lines) =>
        line.length > 0 || Boolean(lines[index - 1]?.length),
    )
    .join("\n")
    .replace(/([^.!?:;\n])\n(?=[a-zа-яёӣӯқғҳҷ])/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export const extractCleanText = (page: Page): string => {
  if (!page.blocks) {
    return cleanupRecognizedText(page.text)
  }

  const lines: string[] = []

  for (const block of page.blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words = line.words
          .filter((word) => word.confidence >= MIN_WORD_CONFIDENCE)
          .map((word) => word.text)

        if (words.length > 0) {
          lines.push(words.join(" "))
        }
      }
    }
  }

  return cleanupRecognizedText(lines.length > 0 ? lines.join("\n") : page.text)
}
