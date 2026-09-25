import { detectCardQuad } from "./card-detection"
import type {
  DocumentCorners,
  Point,
  PreprocessingVariant,
  ProcessingImage,
} from "./scanner.types"

const MAX_SOURCE_SIDE = 3000
const DETECTION_SIDE = 720
const OCR_TARGET_WIDTH = 1800
const MAX_OCR_WIDTH = 2400

const requireContext = (
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D => {
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("Canvas недоступен в этом браузере.")
  return context
}

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("Не удалось создать обработанное изображение."))
    }, "image/png")
  })

const imageFromCanvas = async (
  canvas: HTMLCanvasElement,
): Promise<ProcessingImage> => {
  const blob = await canvasToBlob(canvas)
  return {
    blob,
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  }
}

export const revokeProcessingImage = (image: ProcessingImage | null): void => {
  if (image) URL.revokeObjectURL(image.url)
}

export const validateImageFile = (file: File): void => {
  const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"])
  if (!acceptedTypes.has(file.type)) {
    throw new Error("Поддерживаются только JPG, JPEG, PNG и WebP.")
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error("Изображение слишком большое. Максимальный размер — 20 МБ.")
  }
}

export const loadSourceImage = async (file: File): Promise<ProcessingImage> => {
  validateImageFile(file)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
  } catch {
    throw new Error("Файл повреждён или браузер не смог прочитать изображение.")
  }
  const scale = Math.min(
    1,
    MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height),
  )
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = requireContext(canvas)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return imageFromCanvas(canvas)
}

const bitmapFromBlob = (blob: Blob): Promise<ImageBitmap> =>
  createImageBitmap(blob, { imageOrientation: "from-image" })

const grayscale = (pixels: Uint8ClampedArray): Float32Array => {
  const values = new Float32Array(pixels.length / 4)
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex += 1) {
    const offset = pixelIndex * 4
    values[pixelIndex] =
      pixels[offset] * 0.299 +
      pixels[offset + 1] * 0.587 +
      pixels[offset + 2] * 0.114
  }
  return values
}

const blur3x3 = (
  source: Float32Array,
  width: number,
  height: number,
): Float32Array => {
  const output = new Float32Array(source.length)
  for (let row = 1; row < height - 1; row += 1) {
    for (let column = 1; column < width - 1; column += 1) {
      let sum = 0
      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
          sum += source[(row + rowOffset) * width + column + columnOffset]
        }
      }
      output[row * width + column] = sum / 9
    }
  }
  return output
}

const FALLBACK_INSET = 0.01
const FALLBACK_CONFIDENCE = 0.4

const wholeFrameCorners = (width: number, height: number): DocumentCorners => ({
  topLeft: { x: width * FALLBACK_INSET, y: height * FALLBACK_INSET },
  topRight: { x: width * (1 - FALLBACK_INSET), y: height * FALLBACK_INSET },
  bottomRight: {
    x: width * (1 - FALLBACK_INSET),
    y: height * (1 - FALLBACK_INSET),
  },
  bottomLeft: { x: width * FALLBACK_INSET, y: height * (1 - FALLBACK_INSET) },
})

export type DetectionResult = {
  corners: DocumentCorners
  confidence: number
  preview: ProcessingImage
}

export const detectDocument = async (
  source: ProcessingImage,
): Promise<DetectionResult> => {
  const bitmap = await bitmapFromBlob(source.blob)
  const detectionScale = Math.min(
    1,
    DETECTION_SIDE / Math.max(bitmap.width, bitmap.height),
  )
  const width = Math.max(1, Math.round(bitmap.width * detectionScale))
  const height = Math.max(1, Math.round(bitmap.height * detectionScale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = requireContext(canvas)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const imageData = context.getImageData(0, 0, width, height)
  const found = detectCardQuad(imageData.data, width, height)
  const detectedCorners = found?.corners ?? wholeFrameCorners(width, height)
  const confidence = found?.confidence ?? FALLBACK_CONFIDENCE

  const sourceScaleX = source.width / width
  const sourceScaleY = source.height / height
  const corners: DocumentCorners = Object.fromEntries(
    Object.entries(detectedCorners).map(([key, point]) => [
      key,
      { x: point.x * sourceScaleX, y: point.y * sourceScaleY },
    ]),
  ) as DocumentCorners

  context.lineWidth = Math.max(2, width / 250)
  context.strokeStyle = confidence >= 0.55 ? "#22c55e" : "#f59e0b"
  context.fillStyle = "rgba(37, 99, 235, 0.12)"
  context.beginPath()
  context.moveTo(detectedCorners.topLeft.x, detectedCorners.topLeft.y)
  context.lineTo(detectedCorners.topRight.x, detectedCorners.topRight.y)
  context.lineTo(detectedCorners.bottomRight.x, detectedCorners.bottomRight.y)
  context.lineTo(detectedCorners.bottomLeft.x, detectedCorners.bottomLeft.y)
  context.closePath()
  context.fill()
  context.stroke()
  return { corners, confidence, preview: await imageFromCanvas(canvas) }
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(second.x - first.x, second.y - first.y)

export const cropDocument = async (
  source: ProcessingImage,
  corners: DocumentCorners,
): Promise<ProcessingImage> => {
  const horizontalCoordinates = [
    corners.topLeft.x,
    corners.topRight.x,
    corners.bottomRight.x,
    corners.bottomLeft.x,
  ]
  const verticalCoordinates = [
    corners.topLeft.y,
    corners.topRight.y,
    corners.bottomRight.y,
    corners.bottomLeft.y,
  ]
  const left = Math.max(0, Math.floor(Math.min(...horizontalCoordinates)))
  const top = Math.max(0, Math.floor(Math.min(...verticalCoordinates)))
  const right = Math.min(
    source.width,
    Math.ceil(Math.max(...horizontalCoordinates)),
  )
  const bottom = Math.min(
    source.height,
    Math.ceil(Math.max(...verticalCoordinates)),
  )
  if (right - left < 100 || bottom - top < 100)
    throw new Error("Выбранная область документа слишком мала.")
  const bitmap = await bitmapFromBlob(source.blob)
  const canvas = document.createElement("canvas")
  canvas.width = right - left
  canvas.height = bottom - top
  requireContext(canvas).drawImage(
    bitmap,
    left,
    top,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  bitmap.close()
  return imageFromCanvas(canvas)
}

const solveLinearSystem = (matrix: number[][], values: number[]): number[] => {
  const size = values.length
  const augmented = matrix.map((row, index) => [...row, values[index]])
  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot]))
        bestRow = row
    }
    ;[augmented[pivot], augmented[bestRow]] = [
      augmented[bestRow],
      augmented[pivot],
    ]
    const divisor = augmented[pivot][pivot]
    if (Math.abs(divisor) < 1e-9)
      throw new Error("Границы документа образуют некорректную область.")
    for (let column = pivot; column <= size; column += 1)
      augmented[pivot][column] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue
      const factor = augmented[row][pivot]
      for (let column = pivot; column <= size; column += 1)
        augmented[row][column] -= factor * augmented[pivot][column]
    }
  }
  return augmented.map((row) => row[size])
}

const homographyFromOutput = (output: Point[], input: Point[]): number[] => {
  const matrix: number[][] = []
  const values: number[] = []
  for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
    const { x, y } = output[pointIndex]
    const source = input[pointIndex]
    matrix.push([x, y, 1, 0, 0, 0, -source.x * x, -source.x * y])
    values.push(source.x)
    matrix.push([0, 0, 0, x, y, 1, -source.y * x, -source.y * y])
    values.push(source.y)
  }
  return solveLinearSystem(matrix, values)
}

export const correctPerspective = async (
  source: ProcessingImage,
  corners: DocumentCorners,
): Promise<ProcessingImage> => {
  const outputWidth = Math.max(
    200,
    Math.round(
      Math.max(
        distance(corners.topLeft, corners.topRight),
        distance(corners.bottomLeft, corners.bottomRight),
      ),
    ),
  )
  const outputHeight = Math.max(
    200,
    Math.round(
      Math.max(
        distance(corners.topLeft, corners.bottomLeft),
        distance(corners.topRight, corners.bottomRight),
      ),
    ),
  )
  const boundedScale = Math.min(1, MAX_OCR_WIDTH / outputWidth)
  const width = Math.round(outputWidth * boundedScale)
  const height = Math.round(outputHeight * boundedScale)
  const inputPoints = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft,
  ]
  const outputPoints = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ]
  const transform = homographyFromOutput(outputPoints, inputPoints)
  const bitmap = await bitmapFromBlob(source.blob)
  const sourceCanvas = document.createElement("canvas")
  sourceCanvas.width = source.width
  sourceCanvas.height = source.height
  const sourceContext = requireContext(sourceCanvas)
  sourceContext.drawImage(bitmap, 0, 0)
  bitmap.close()
  const sourcePixels = sourceContext.getImageData(
    0,
    0,
    source.width,
    source.height,
  ).data
  const outputCanvas = document.createElement("canvas")
  outputCanvas.width = width
  outputCanvas.height = height
  const outputContext = requireContext(outputCanvas)
  const outputImage = outputContext.createImageData(width, height)
  for (let outputY = 0; outputY < height; outputY += 1) {
    for (let outputX = 0; outputX < width; outputX += 1) {
      const denominator = transform[6] * outputX + transform[7] * outputY + 1
      const sourceX = Math.round(
        (transform[0] * outputX + transform[1] * outputY + transform[2]) /
          denominator,
      )
      const sourceY = Math.round(
        (transform[3] * outputX + transform[4] * outputY + transform[5]) /
          denominator,
      )
      const outputOffset = (outputY * width + outputX) * 4
      if (
        sourceX >= 0 &&
        sourceX < source.width &&
        sourceY >= 0 &&
        sourceY < source.height
      ) {
        const sourceOffset = (sourceY * source.width + sourceX) * 4
        outputImage.data.set(
          sourcePixels.subarray(sourceOffset, sourceOffset + 4),
          outputOffset,
        )
      } else {
        outputImage.data.set([255, 255, 255, 255], outputOffset)
      }
    }
  }
  outputContext.putImageData(outputImage, 0, 0)
  return imageFromCanvas(outputCanvas)
}

const projectionScore = (
  grayValues: Float32Array,
  width: number,
  height: number,
  angle: number,
): number => {
  const radians = (angle * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const rows = new Float64Array(height)
  const centerX = width / 2
  const centerY = height / 2
  for (let row = 0; row < height; row += 2) {
    for (let column = 0; column < width; column += 2) {
      if (grayValues[row * width + column] > 190) continue
      const rotatedY = Math.round(
        -(column - centerX) * sine + (row - centerY) * cosine + centerY,
      )
      if (rotatedY >= 0 && rotatedY < height)
        rows[rotatedY] += 255 - grayValues[row * width + column]
    }
  }
  let score = 0
  for (let row = 1; row < height; row += 1)
    score += (rows[row] - rows[row - 1]) ** 2
  return score
}

export const deskewImage = async (
  source: ProcessingImage,
): Promise<ProcessingImage> => {
  const bitmap = await bitmapFromBlob(source.blob)
  const analysisScale = Math.min(1, 800 / source.width)
  const analysisCanvas = document.createElement("canvas")
  analysisCanvas.width = Math.round(source.width * analysisScale)
  analysisCanvas.height = Math.round(source.height * analysisScale)
  const analysisContext = requireContext(analysisCanvas)
  analysisContext.drawImage(
    bitmap,
    0,
    0,
    analysisCanvas.width,
    analysisCanvas.height,
  )
  const grayValues = grayscale(
    analysisContext.getImageData(
      0,
      0,
      analysisCanvas.width,
      analysisCanvas.height,
    ).data,
  )
  let bestAngle = 0
  let bestScore = projectionScore(
    grayValues,
    analysisCanvas.width,
    analysisCanvas.height,
    0,
  )
  for (let angle = -5; angle <= 5; angle += 0.5) {
    const score = projectionScore(
      grayValues,
      analysisCanvas.width,
      analysisCanvas.height,
      angle,
    )
    if (score > bestScore) {
      bestScore = score
      bestAngle = angle
    }
  }
  const canvas = document.createElement("canvas")
  canvas.width = source.width
  canvas.height = source.height
  const context = requireContext(canvas)
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.translate(canvas.width / 2, canvas.height / 2)
  context.rotate((bestAngle * Math.PI) / 180)
  context.drawImage(
    bitmap,
    -canvas.width / 2,
    -canvas.height / 2,
    canvas.width,
    canvas.height,
  )
  bitmap.close()
  return imageFromCanvas(canvas)
}

const percentileRange = (
  values: Uint8ClampedArray,
): { low: number; high: number } => {
  const histogram = new Uint32Array(256)
  values.forEach((value) => {
    histogram[value] += 1
  })
  const clip = values.length * 0.015
  let low = 0
  let high = 255
  let count = 0
  for (let value = 0; value < 256; value += 1) {
    count += histogram[value]
    if (count >= clip) {
      low = value
      break
    }
  }
  count = 0
  for (let value = 255; value >= 0; value -= 1) {
    count += histogram[value]
    if (count >= clip) {
      high = value
      break
    }
  }
  return { low, high: Math.max(low + 1, high) }
}

const otsuThreshold = (values: Uint8ClampedArray): number => {
  const histogram = new Uint32Array(256)
  values.forEach((value) => {
    histogram[value] += 1
  })
  let totalSum = 0
  for (let value = 0; value < 256; value += 1)
    totalSum += value * histogram[value]
  let backgroundWeight = 0
  let backgroundSum = 0
  let maximumVariance = 0
  let threshold = 127
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value]
    if (backgroundWeight === 0) continue
    const foregroundWeight = values.length - backgroundWeight
    if (foregroundWeight === 0) break
    backgroundSum += value * histogram[value]
    const difference =
      backgroundSum / backgroundWeight -
      (totalSum - backgroundSum) / foregroundWeight
    const variance =
      backgroundWeight * foregroundWeight * difference * difference
    if (variance > maximumVariance) {
      maximumVariance = variance
      threshold = value
    }
  }
  return threshold
}

export const createPreprocessingVariants = async (
  source: ProcessingImage,
): Promise<PreprocessingVariant[]> => {
  const bitmap = await bitmapFromBlob(source.blob)
  const scale = Math.min(
    MAX_OCR_WIDTH / source.width,
    Math.max(1, OCR_TARGET_WIDTH / source.width),
  )
  const width = Math.round(source.width * scale)
  const height = Math.round(source.height * scale)
  const baseCanvas = document.createElement("canvas")
  baseCanvas.width = width
  baseCanvas.height = height
  const baseContext = requireContext(baseCanvas)
  baseContext.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const sourceData = baseContext.getImageData(0, 0, width, height)
  const grayFloat = grayscale(sourceData.data)
  const grayValues = new Uint8ClampedArray(grayFloat.length)
  for (let index = 0; index < grayFloat.length; index += 1)
    grayValues[index] = grayFloat[index]
  const denoised = blur3x3(grayFloat, width, height)
  const { low, high } = percentileRange(grayValues)
  const range = high - low
  const contrasted = new Uint8ClampedArray(grayValues.length)
  for (let index = 0; index < contrasted.length; index += 1) {
    contrasted[index] = Math.max(
      0,
      Math.min(255, ((denoised[index] - low) / range) * 255),
    )
  }
  const threshold = otsuThreshold(contrasted)
  const makeVariant = async (
    id: PreprocessingVariant["id"],
    label: string,
  ): Promise<PreprocessingVariant> => {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = requireContext(canvas)
    const imageData = context.createImageData(width, height)
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column
        let value = contrasted[index]
        if (id === "threshold") value = value > threshold ? 255 : 0
        if (
          id === "sharpen" &&
          row > 0 &&
          row < height - 1 &&
          column > 0 &&
          column < width - 1
        ) {
          const blurred =
            (contrasted[index - 1] +
              contrasted[index + 1] +
              contrasted[index - width] +
              contrasted[index + width]) /
            4
          value = Math.max(
            0,
            Math.min(255, contrasted[index] * 1.8 - blurred * 0.8),
          )
        }
        const offset = index * 4
        imageData.data[offset] = value
        imageData.data[offset + 1] = value
        imageData.data[offset + 2] = value
        imageData.data[offset + 3] = 255
      }
    }
    context.putImageData(imageData, 0, 0)
    return { id, label, image: await imageFromCanvas(canvas) }
  }
  return Promise.all([
    makeVariant("contrast", "Grayscale + contrast + denoise"),
    makeVariant("threshold", "Otsu threshold"),
    makeVariant("sharpen", "Contrast + sharpen"),
  ])
}
