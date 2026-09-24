import { createWorker, OEM, PSM } from "tesseract.js"
import type { Page } from "tesseract.js"
import { extractCleanText } from "./home.utils"
import { extractIdCardFields } from "./id-card.utils"
import {
  extractLayoutFields,
  extractMrzFields,
  mergeRecognizedFields,
} from "./id-card-recognition"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import type { OcrResult, PreprocessingVariant } from "./scanner.types"

const OCR_LANGUAGES = ["eng", "rus", "tgk"]

type OcrCandidate = {
  result: OcrResult
  page: Page
}

export type IdCardOcrOutput = {
  ocrResult: OcrResult
  rawText: string
  mrzText: string
  mrzConfidence: number
  fields: Partial<Record<IdCardFieldKey, RecognizedField>>
}

type RecognizeIdCardOptions = {
  variants: PreprocessingVariant[]
  onStatus: (message: string, progress: number) => void
  shouldContinue: () => boolean
}

const LABEL_WORDS =
  /насаб|surname|номи|падар|падap|napap|father|^ном\b|^(name|мате|mate|nате|наме)$|birth|таваллуд|санаи|document|рақами|раками|шиноснома|nationality|authority|мақоми|address|нишон|issue|expiry|place\s*of|^sex$|чинс/i

type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

const dropLabelValues = (fields: FieldMap): FieldMap => {
  const cleaned: FieldMap = {}
  for (const key of Object.keys(fields) as IdCardFieldKey[]) {
    const field = fields[key]
    if (field && !LABEL_WORDS.test(field.value.trim())) cleaned[key] = field
  }
  return cleaned
}

const TEXT_PARSER_CONFIDENCE = 80

const extractTextFields = (text: string): FieldMap => {
  const parsed = extractIdCardFields(text)
  const fields: FieldMap = {}
  for (const key of Object.keys(parsed) as IdCardFieldKey[]) {
    const value = parsed[key].trim()
    if (value)
      fields[key] = {
        value,
        confidence: TEXT_PARSER_CONFIDENCE,
        source: "layout",
      }
  }
  return fields
}

const candidateScore = (candidate: OcrCandidate): number =>
  candidate.result.confidence +
  Object.keys(extractLayoutFields(candidate.page)).length * 3

const probableMrzLineCount = (page: Page): number =>
  page.text
    .split("\n")
    .map((line) => line.replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 28 && line.length <= 32).length

export const recognizeIdCard = async ({
  variants,
  onStatus,
  shouldContinue,
}: RecognizeIdCardOptions): Promise<IdCardOcrOutput> => {
  if (variants.length === 0)
    throw new Error("Нет подготовленных изображений для OCR.")
  const worker = await createWorker(OCR_LANGUAGES, OEM.LSTM_ONLY, {
    logger: (message) => {
      if (shouldContinue() && message.status === "recognizing text") {
        onStatus("Распознавание текста", Math.round(message.progress * 100))
      }
    },
  })
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    })
    const candidates: OcrCandidate[] = []
    for (const variant of variants) {
      if (!shouldContinue()) throw new Error("OCR отменён.")
      onStatus(`OCR: ${variant.label}`, 0)
      await worker.setParameters({
        tessedit_pageseg_mode:
          variant.id === "threshold" ? PSM.AUTO : PSM.SPARSE_TEXT,
      })
      const recognition = await worker.recognize(
        variant.image.blob,
        {},
        { blocks: true },
      )
      candidates.push({
        result: {
          text: extractCleanText(recognition.data),
          confidence: recognition.data.confidence,
          variantId: variant.id,
        },
        page: recognition.data,
      })
    }
    const bestCandidate = candidates.reduce((best, candidate) =>
      candidateScore(candidate) > candidateScore(best) ? candidate : best,
    )
    onStatus("Отдельное распознавание MRZ", 0)
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "0",
    })
    const bestVariant =
      variants.find(
        (variant) => variant.id === bestCandidate.result.variantId,
      ) ?? variants[0]
    const mrzVariants = [
      bestVariant,
      ...variants.filter((variant) => variant.id !== bestVariant.id),
    ].slice(0, 2)
    const mrzPages: Page[] = []
    for (const variant of mrzVariants) {
      if (!shouldContinue()) throw new Error("OCR отменён.")
      const top = Math.round(variant.image.height * 0.55)
      const recognition = await worker.recognize(
        variant.image.blob,
        {
          rectangle: {
            left: 0,
            top,
            width: variant.image.width,
            height: variant.image.height - top,
          },
        },
        { blocks: true },
      )
      mrzPages.push(recognition.data)
    }
    const bestMrzPage = mrzPages.reduce((best, page) => {
      const score = page.confidence + probableMrzLineCount(page) * 25
      const bestScore = best.confidence + probableMrzLineCount(best) * 25
      return score > bestScore ? page : best
    })
    return {
      ocrResult: bestCandidate.result,
      rawText: bestCandidate.result.text,
      mrzText: bestMrzPage.text.trim(),
      mrzConfidence: bestMrzPage.confidence,
      fields: mergeRecognizedFields(
        dropLabelValues(extractLayoutFields(bestCandidate.page)),
        extractTextFields(bestCandidate.result.text),
        extractMrzFields(bestMrzPage.text, bestMrzPage.confidence),
      ),
    }
  } finally {
    await worker.terminate()
  }
}
