import type { Page } from "tesseract.js"

const MIN_TARGET_WIDTH = 1600
const MAX_UPSCALE = 2.5
const CLIP_PERCENT = 0.02
const MIN_WORD_CONFIDENCE = 60

export const extractCleanText = (page: Page): string => {
  if (!page.blocks) {
    return page.text
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

  return lines.join("\n")
}

export const preprocessImage = async (file: File): Promise<string> => {
  const bitmap = await createImageBitmap(file)

  const scale = Math.min(MAX_UPSCALE, Math.max(1, MIN_TARGET_WIDTH / bitmap.width))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext("2d")

  if (!ctx) {
    return URL.createObjectURL(file)
  }

  ctx.drawImage(bitmap, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData
  const gray = new Uint8ClampedArray(width * height)

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }

  const histogram = new Array(256).fill(0)
  for (let p = 0; p < gray.length; p += 1) {
    histogram[gray[p]] += 1
  }

  const clipCount = Math.floor(gray.length * CLIP_PERCENT)
  let low = 0
  let high = 255

  for (let sum = 0, value = 0; value < 256; value += 1) {
    sum += histogram[value]
    if (sum > clipCount) {
      low = value
      break
    }
  }

  for (let sum = 0, value = 255; value >= 0; value -= 1) {
    sum += histogram[value]
    if (sum > clipCount) {
      high = value
      break
    }
  }

  const range = Math.max(1, high - low)

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const stretched = ((gray[p] - low) / range) * 255
    const value = Math.min(255, Math.max(0, Math.round(stretched)))

    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
  }

  ctx.putImageData(imageData, 0, 0)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))

  return blob ? URL.createObjectURL(blob) : URL.createObjectURL(file)
}
