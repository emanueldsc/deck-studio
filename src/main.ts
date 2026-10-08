import { Editor } from '@tiptap/core'
import Color from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'
import {
    ActiveSelection,
    Canvas,
    Control,
    controlsUtils,
    Ellipse,
    Color as FabricColor,
    FabricImage,
    FabricText,
    Line,
    Polygon,
    Rect,
    Textbox,
    Triangle,
    type FabricObject,
    type Point,
} from 'fabric'
import { jsPDF } from 'jspdf'
import JSZip from 'jszip'
import {
    activeDeckFileHandle,
    activeDeckPermissionGranted,
    clearActiveDeckFileHandle,
    createDeckArchive,
    readDeckArchive,
    saveLightweightAutosave,
    selecionarLocalArquivo,
    stripImagePayloads,
    writeActiveDeckFile,
} from './deck-persistence'
import { withLoading } from './loading'
import './style.css'

type LayerKind =
  | 'base'
  | 'image'
  | 'text'
  | 'shape'
  | 'graphic'

type ShapeType = 'rect' | 'rounded' | 'ellipse' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon' | 'star' | 'line'

type LayerScope = 'model' | 'deck' | 'back'
type EditMode = LayerScope
type ImageFitMode = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'
type AssetScaleMode = 'stretch' | 'nine-slice'
type TextAlignMode = 'left' | 'center' | 'right' | 'justify'
type TextVerticalAlignMode = 'top' | 'middle' | 'bottom'
type TextOverflowMode = 'expand' | 'clip'
type RichTextFormat = 'tags' | 'html'

interface ShadowOverride {
  color: string
  blur: number
  offsetX: number
  offsetY: number
}

interface CardTextPropsOverride {
  width?: number
  fontFamily?: string
  fontSize?: number
  fontWeight?: string | number
  fontStyle?: string
  underline?: boolean
  linethrough?: boolean
  overline?: boolean
  fill?: string
  stroke?: string
  strokeWidth?: number
  textAlign?: TextAlignMode
  textVerticalAlign?: TextVerticalAlignMode
  textOverflow?: TextOverflowMode
  textBoxHeight?: number
  lineHeight?: number
  shadow?: ShadowOverride | null
}

interface LayerMeta {
  id: string
  name: string
  kind: LayerKind
  scope: LayerScope
  fit?: ImageFitMode
  slotWidth?: number
  slotHeight?: number
  cropPositionX?: number
  cropPositionY?: number
  richTextSource?: string
  richTextFormat?: RichTextFormat
  textVerticalAlign?: TextVerticalAlignMode
  textOverflow?: TextOverflowMode
  textBoxHeight?: number
  graphicSource?: string
  scaleMode?: AssetScaleMode
  locked?: boolean
  isBackground?: boolean
  insetTop?: number
  insetRight?: number
  insetBottom?: number
  insetLeft?: number
}

interface CardModelOverride {
  text?: string
  richText?: string
  richTextFormat?: RichTextFormat
  textProps?: CardTextPropsOverride
  src?: string
  fit?: ImageFitMode
  cropPositionX?: number
  cropPositionY?: number
  hidden?: boolean
}

interface CardState {
  id: string
  name: string
  canvas?: ReturnType<Canvas['toObject']>
  deckObjects?: unknown[]
  modelId: string
  backId: string
  modelOverrides: Record<string, CardModelOverride>
  thumbnail: string
}

interface CardModel {
  id: string
  name: string
  canvas: ReturnType<Canvas['toObject']>
}

interface CardBack {
  id: string
  name: string
  canvas: ReturnType<Canvas['toObject']>
  thumbnail: string
}

interface LibraryAsset {
  id: string
  name: string
  src: string
  width: number
  height: number
  scaleMode?: AssetScaleMode
  insetTop?: number
  insetRight?: number
  insetBottom?: number
  insetLeft?: number
}

interface DeckDocument {
  id: string
  name: string
  models: CardModel[]
  backs: CardBack[]
  library: LibraryAsset[]
  activeModelId: string
  activeBackId: string
  cards: CardState[]
  activeCardId: string
  cover?: string
}

type CoverMode = 'off' | 'cover' | 'blur'
let coverMode: CoverMode = 'blur'

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Elemento #app nao encontrado.')
}

type ColorTheme = 'light' | 'dark'
const COLOR_THEME_STORAGE_KEY = 'deckstudio.color-theme'

function getInitialColorTheme(): ColorTheme {
  const savedTheme = localStorage.getItem(COLOR_THEME_STORAGE_KEY)
  if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyColorTheme(theme: ColorTheme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

applyColorTheme(getInitialColorTheme())

const CARD_WIDTH = 630
const CARD_HEIGHT = 880
const ZOOM_MIN = 0.2
const ZOOM_MAX = 4
const ZOOM_STEP = 0.05
const PREVIEW_MAX_CARDS = 48
const FONT_OPTIONS = [
  'Cinzel Decorative',
  'Galada',
  'Lobster Two',
  'Arial',
  'Times New Roman',
  'Courier New',
]

const DEFAULT_DECK_NAME = 'Baralho 1'
const SAVED_TEXT_COLORS_KEY = 'deckstudio.saved-text-styles-v2'
const DEFAULT_SAVED_TEXT_COLORS = ['#cd7f32', '#a8a9ad', '#d4a017', '#2f9e44', '#1971c2']
const DEFAULT_SAVED_TEXT_FOREGROUNDS = ['#ffffff', '#111111', '#111111', '#ffffff', '#ffffff']

interface CardTemplatePreset {
  id: string
  name: string
  family: string
  description: string
  colors: [string, string, string, string]
  title: string
  typeLine: string
  rules: string
  stats: string
  ornament: 'leaves' | 'runes' | 'flames' | 'waves' | 'moon' | 'clean'
  layout: 'classic' | 'fullbleed' | 'splitLeft' | 'landscape' | 'splitRight' | 'poster'
}

const CARD_TEMPLATE_PRESETS: CardTemplatePreset[] = [
  {
    id: 'bosque', name: 'Clareira do Bosque', family: 'Aventura',
    description: 'Madeira, papel e folhas para personagens e facções.',
    colors: ['#243c2d', '#d9c89b', '#f4ecd5', '#9b5f32'],
    title: 'GUARDIÃO DA CLAREIRA', typeLine: 'Habitante • Protetor',
    rules: 'Ao entrar em jogo, escolha uma clareira.\nAliados nela recebem +1 de defesa.',
    stats: '3  ◆  5', ornament: 'leaves', layout: 'classic',
  },
  {
    id: 'arcano', name: 'Relíquia Arcana', family: 'Fantasia TCG',
    description: 'Arte em sangria total com informações flutuando sobre a cena.',
    colors: ['#17233d', '#b18a43', '#eee2c3', '#594171'],
    title: 'ORÁCULO DAS MARÉS', typeLine: 'Criatura • Místico',
    rules: 'Vigilância\nQuando esta carta for revelada, compre uma carta e descarte uma carta.',
    stats: '2 / 4', ornament: 'runes', layout: 'fullbleed',
  },
  {
    id: 'forja', name: 'Coração da Forja', family: 'Batalha',
    description: 'Arte vertical à esquerda e ficha completa à direita.',
    colors: ['#351510', '#d26a2e', '#f2d2a0', '#721f17'],
    title: 'FERREIRO DE CINZAS', typeLine: 'Campeão • Artesão',
    rules: 'Investida\nSempre que atacar, cause 1 de dano a um alvo adjacente.',
    stats: '6  /  3', ornament: 'flames', layout: 'splitLeft',
  },
  {
    id: 'abissal', name: 'Maré Abissal', family: 'Místico',
    description: 'Composição editorial com ilustração panorâmica e rodapé amplo.',
    colors: ['#082f49', '#2b91a3', '#d8f0e9', '#164e63'],
    title: 'NAVEGANTE DO ABISMO', typeLine: 'Explorador • Oceânico',
    rules: 'Fluxo — Se você jogou outra carta neste turno, mova até 2 espaços.',
    stats: '4  ◇  4', ornament: 'waves', layout: 'landscape',
  },
  {
    id: 'eclipse', name: 'Corte do Eclipse', family: 'Sombrio',
    description: 'Ficha lateral à esquerda e retrato alto à direita.',
    colors: ['#171421', '#8a6ca8', '#e7e0ec', '#42334f'],
    title: 'REGENTE DO ECLIPSE', typeLine: 'Lenda • Soberano',
    rules: 'Único\nNo início da noite, coloque um marcador de presságio nesta carta.',
    stats: '7  ✦  7', ornament: 'moon', layout: 'splitRight',
  },
  {
    id: 'cronica', name: 'Crônica Essencial', family: 'Minimalista',
    description: 'Pôster contemporâneo com imagem dominante e tipografia limpa.',
    colors: ['#20252b', '#d6a84b', '#f5f1e8', '#6b747c'],
    title: 'NOME DA CARTA', typeLine: 'Categoria • Subtipo',
    rules: 'Escreva aqui o efeito da carta.\nUse este espaço para regras, custo e condições.',
    stats: '03  /  05', ornament: 'clean', layout: 'poster',
  },
]

interface SavedTextStyle {
  color: string
  backgroundColor: string
  borderRadius: number
  paddingX: number
  paddingY: number
  fontSize: number
}

const StyledTextStyle = TextStyle.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) => element.style.backgroundColor || null,
        renderHTML: (attributes) => attributes.backgroundColor
          ? { style: `background-color: ${attributes.backgroundColor}` }
          : {},
      },
      borderRadius: {
        default: null,
        parseHTML: (element) => element.style.borderRadius || null,
        renderHTML: (attributes) => attributes.borderRadius
          ? { style: `border-radius: ${attributes.borderRadius}` }
          : {},
      },
      textPadding: {
        default: null,
        parseHTML: (element) => element.style.padding || null,
        renderHTML: (attributes) => attributes.textPadding
          ? { style: `padding: ${attributes.textPadding}` }
          : {},
      },
      presetFontSize: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
        renderHTML: (attributes) => attributes.presetFontSize
          ? { style: `font-size: ${attributes.presetFontSize}` }
          : {},
      },
      fontFamily: {
        default: null,
        parseHTML: (element) => element.style.fontFamily || null,
        renderHTML: (attributes) => attributes.fontFamily
          ? { style: `font-family: ${attributes.fontFamily}` }
          : {},
      },
      fontSize: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
        renderHTML: (attributes) => attributes.fontSize
          ? { style: `font-size: ${attributes.fontSize}` }
          : {},
      },
    }
  },
})

interface SizePreset {
  key: string
  label: string
  widthMm: number
  heightMm: number
}

const CARD_SIZE_PRESETS: SizePreset[] = [
  { key: 'tcg', label: '63 x 88 mm (TCG)', widthMm: 63, heightMm: 88 },
  { key: 'yugioh', label: '59 x 86 mm (Yu-Gi-Oh)', widthMm: 59, heightMm: 86 },
  { key: 'poker', label: '63 x 89 mm (Poker)', widthMm: 63, heightMm: 89 },
  { key: 'uno', label: '56 x 87 mm (UNO)', widthMm: 56, heightMm: 87 },
  { key: 'uno-itu', label: '100 x 150 mm (UNO ITU)', widthMm: 100, heightMm: 150 },
  { key: 'euro-standard', label: '59 x 92 mm (Euro Standard)', widthMm: 59, heightMm: 92 },
  { key: 'euro-mini', label: '44 x 68 mm (Euro Mini)', widthMm: 44, heightMm: 68 },
  { key: 'taro', label: '70 x 120 mm (Taro)', widthMm: 70, heightMm: 120 },
]

const PAPER_SIZE_PRESETS: SizePreset[] = [
  { key: 'a4', label: 'A4 (210 x 297 mm)', widthMm: 210, heightMm: 297 },
  { key: 'a3', label: 'A3 (297 x 420 mm)', widthMm: 297, heightMm: 420 },
  { key: 'a5', label: 'A5 (148 x 210 mm)', widthMm: 148, heightMm: 210 },
  { key: 'letter', label: 'Carta (216 x 279 mm)', widthMm: 216, heightMm: 279 },
  { key: 'oficio', label: 'Oficio (216 x 330 mm)', widthMm: 216, heightMm: 330 },
]

const NAMED_TEXT_COLORS: Record<string, string> = {
  verde: '#2f9e44',
  vermelho: '#d90429',
  azul: '#1971c2',
  amarelo: '#f08c00',
  laranja: '#e8590c',
  roxo: '#6f42c1',
  rosa: '#d63384',
  branco: '#ffffff',
  preto: '#111111',
  cinza: '#6c757d',
  marrom: '#7f5539',
  bronze: '#cd7f32',
  cobre: '#b87333',
  prata: '#a8a9ad',
  dourado: '#d4a017',
}

let activeEditMode: EditMode = 'deck'
let deckCount = 0
let deckDocuments: DeckDocument[] = []
let activeDeckId = ''
let cropPanLayerId: string | null = null

function generateDeckId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  deckCount += 1
  return `deck-${Date.now()}-${deckCount}`
}

function createEmptyCanvasState(): ReturnType<Canvas['toObject']> {
  return {
    version: '7.4.0',
    objects: [],
  } as ReturnType<Canvas['toObject']>
}

function createDeckDocument(name = DEFAULT_DECK_NAME): DeckDocument {
  const model: CardModel = { id: generateDeckId(), name: 'Modelo 1', canvas: createEmptyCanvasState() }
  const back: CardBack = { id: generateDeckId(), name: 'Verso 1', canvas: createEmptyCanvasState(), thumbnail: '' }
  const firstCard: CardState = {
    id: generateDeckId(),
    name: 'Carta 1',
    canvas: createEmptyCanvasState(),
    modelId: model.id,
    backId: back.id,
    modelOverrides: {},
    thumbnail: '',
  }
  return {
    id: generateDeckId(),
    name,
    models: [model],
    backs: [back],
    library: [],
    activeModelId: model.id,
    activeBackId: back.id,
    cards: [firstCard],
    activeCardId: firstCard.id,
  }
}

function activeModelOf(deck: DeckDocument): CardModel {
  return deck.models.find(m => m.id === deck.activeModelId) ?? deck.models[0]
}

function activeBackOf(deck: DeckDocument): CardBack {
  return deck.backs.find(b => b.id === deck.activeBackId) ?? deck.backs[0]
}

function modelOfCard(deck: DeckDocument, card: CardState | undefined): CardModel {
  return deck.models.find(m => m.id === card?.modelId) ?? deck.models[0]
}

function backOfCard(deck: DeckDocument, card: CardState | undefined): CardBack {
  return deck.backs.find(b => b.id === card?.backId) ?? deck.backs[0]
}

function deepClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isImageFitMode(value: unknown): value is ImageFitMode {
  return value === 'fill' || value === 'contain' || value === 'cover' || value === 'none' || value === 'scale-down'
}

function normalizeImageFit(value: unknown, fallback: ImageFitMode = 'contain'): ImageFitMode {
  return isImageFitMode(value) ? value : fallback
}

function isTextAlignMode(value: unknown): value is TextAlignMode {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
}

function normalizeTextAlign(value: unknown, fallback: TextAlignMode = 'left'): TextAlignMode {
  return isTextAlignMode(value) ? value : fallback
}

function normalizeTextVerticalAlign(value: unknown): TextVerticalAlignMode {
  return value === 'middle' || value === 'bottom' ? value : 'top'
}

function normalizeTextOverflow(value: unknown): TextOverflowMode {
  return value === 'clip' ? 'clip' : 'expand'
}

function extractShadowOverride(value: unknown): ShadowOverride | null | undefined {
  if (value == null) {
    return null
  }

  if (typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Record<string, unknown>
  const color = typeof candidate['color'] === 'string' ? candidate['color'] : '#000000'
  const blur = typeof candidate['blur'] === 'number' ? candidate['blur'] : 0
  const offsetX = typeof candidate['offsetX'] === 'number' ? candidate['offsetX'] : 2
  const offsetY = typeof candidate['offsetY'] === 'number' ? candidate['offsetY'] : 2

  return {
    color,
    blur,
    offsetX,
    offsetY,
  }
}

function readTextPropsFromSerialized(record: Record<string, unknown>): CardTextPropsOverride {
  const output: CardTextPropsOverride = {}
  const data = record['data'] && typeof record['data'] === 'object'
    ? record['data'] as Partial<LayerMeta>
    : {}

  if (typeof record['width'] === 'number') output.width = record['width']
  if (typeof record['fontFamily'] === 'string') output.fontFamily = record['fontFamily']
  if (typeof record['fontSize'] === 'number') output.fontSize = record['fontSize']
  if (typeof record['fontWeight'] === 'string' || typeof record['fontWeight'] === 'number') {
    output.fontWeight = record['fontWeight']
  }
  if (typeof record['fontStyle'] === 'string') output.fontStyle = record['fontStyle']
  if (typeof record['underline'] === 'boolean') output.underline = record['underline']
  if (typeof record['linethrough'] === 'boolean') output.linethrough = record['linethrough']
  if (typeof record['overline'] === 'boolean') output.overline = record['overline']
  if (typeof record['fill'] === 'string') output.fill = record['fill']
  if (typeof record['stroke'] === 'string') output.stroke = record['stroke']
  if (typeof record['strokeWidth'] === 'number') output.strokeWidth = record['strokeWidth']
  if (isTextAlignMode(record['textAlign'])) output.textAlign = record['textAlign']
  if (data.textVerticalAlign === 'top' || data.textVerticalAlign === 'middle' || data.textVerticalAlign === 'bottom') {
    output.textVerticalAlign = data.textVerticalAlign
  }
  if (data.textOverflow === 'expand' || data.textOverflow === 'clip') output.textOverflow = data.textOverflow
  if (typeof data.textBoxHeight === 'number') output.textBoxHeight = data.textBoxHeight
  if (typeof record['lineHeight'] === 'number') output.lineHeight = record['lineHeight']

  const shadow = extractShadowOverride(record['shadow'])
  if (shadow !== undefined) {
    output.shadow = shadow
  }

  return output
}

function diffCardTextProps(
  current: Record<string, unknown>,
  base: Record<string, unknown>,
): CardTextPropsOverride | undefined {
  const currentProps = readTextPropsFromSerialized(current)
  const baseProps = readTextPropsFromSerialized(base)
  const diff: CardTextPropsOverride = {}

  const keys: Array<keyof CardTextPropsOverride> = [
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'underline',
    'linethrough',
    'overline',
    'fill',
    'stroke',
    'strokeWidth',
    'textAlign',
    'textVerticalAlign',
    'textOverflow',
    'textBoxHeight',
    'lineHeight',
    'shadow',
  ]

  keys.forEach((key) => {
    const currentValue = currentProps[key]
    const baseValue = baseProps[key]
    if (JSON.stringify(currentValue) !== JSON.stringify(baseValue)) {
      ;(diff as Record<string, unknown>)[key] = currentValue
    }
  })

  return Object.keys(diff).length > 0 ? diff : undefined
}

function resolveTextColorTag(rawTag: string): string | null {
  const tag = rawTag.trim().toLowerCase()
  if (!tag) return null

  if (NAMED_TEXT_COLORS[tag]) {
    return NAMED_TEXT_COLORS[tag]
  }

  if (/^#[0-9a-f]{6}$/i.test(tag)) {
    return tag
  }

  if (/^[0-9a-f]{6}$/i.test(tag)) {
    return `#${tag}`
  }

  return null
}

function parseSquareTagToken(token: string):
  | { valid: false }
  | { valid: true; isClosing: boolean; name: string; value?: string } {
  const inner = token.slice(1, -1).trim()
  if (!inner) return { valid: false }

  const isClosing = inner.startsWith('/')
  const payload = isClosing ? inner.slice(1).trim() : inner
  if (!payload) return { valid: false }

  const equalIndex = payload.indexOf('=')
  if (equalIndex < 0) {
    return {
      valid: true,
      isClosing,
      name: payload.toLowerCase(),
    }
  }

  return {
    valid: true,
    isClosing,
    name: payload.slice(0, equalIndex).trim().toLowerCase(),
    value: payload.slice(equalIndex + 1).trim(),
  }
}

function parseTaggedText(
  markup: string,
  fallbackColor: string,
): { text: string; styles: Record<number, Record<number, { fill: string }>> } {
  const styles: Record<number, Record<number, { fill: string }>> = {}
  const colorStack: string[] = []
  const tagRegex = /<\/?[^>]+>|\[(?:\/)?[^\]]+\]/g
  let output = ''
  let lastIndex = 0
  let lineIndex = 0
  let charIndex = 0

  const appendChunk = (chunk: string): void => {
    const activeColor = colorStack[colorStack.length - 1]
    for (const char of chunk) {
      output += char
      if (char === '\n') {
        lineIndex += 1
        charIndex = 0
        continue
      }

      if (activeColor && activeColor.toLowerCase() !== fallbackColor.toLowerCase()) {
        styles[lineIndex] ??= {}
        styles[lineIndex][charIndex] = { fill: activeColor }
      }

      charIndex += 1
    }
  }

  let match: RegExpExecArray | null = tagRegex.exec(markup)
  while (match) {
    appendChunk(markup.slice(lastIndex, match.index))

    const fullTag = match[0]
    if (fullTag.startsWith('<')) {
      const tagName = fullTag.replace(/^<\/?/, '').replace(/>$/, '').trim()
      const isClosing = fullTag.startsWith('</')
      const resolvedColor = resolveTextColorTag(tagName)

      if (!resolvedColor) {
        appendChunk(fullTag)
      } else if (isClosing) {
        const index = colorStack.lastIndexOf(resolvedColor)
        if (index >= 0) {
          colorStack.splice(index, 1)
        }
      } else {
        colorStack.push(resolvedColor)
      }
    } else {
      const parsedSquare = parseSquareTagToken(fullTag)
      if (!parsedSquare.valid) {
        appendChunk(fullTag)
      } else if (parsedSquare.isClosing) {
        if (parsedSquare.name === 'cor' || parsedSquare.name === 'color') {
          colorStack.pop()
        } else {
          const resolvedColor = resolveTextColorTag(parsedSquare.name)
          if (!resolvedColor) {
            appendChunk(fullTag)
          } else {
            const index = colorStack.lastIndexOf(resolvedColor)
            if (index >= 0) {
              colorStack.splice(index, 1)
            }
          }
        }
      } else {
        const fromPair =
          (parsedSquare.name === 'cor' || parsedSquare.name === 'color') && parsedSquare.value
            ? resolveTextColorTag(parsedSquare.value)
            : null
        const fromSingle = fromPair ? null : resolveTextColorTag(parsedSquare.name)
        const resolvedColor = fromPair ?? fromSingle

        if (!resolvedColor) {
          appendChunk(fullTag)
        } else {
          colorStack.push(resolvedColor)
        }
      }
    }

    lastIndex = tagRegex.lastIndex
    match = tagRegex.exec(markup)
  }

  appendChunk(markup.slice(lastIndex))

  return {
    text: output,
    styles,
  }
}

function applyTaggedTextToObject(textObject: FabricText | Textbox, markup: string): void {
  const fallbackFill = toHexColor(String((textObject as { fill?: unknown }).fill ?? '#1c2738'), '#1c2738')
  const parsed = parseTaggedText(markup, fallbackFill)

  textObject.set({
    text: parsed.text,
    styles: parsed.styles,
  })

  const meta = getLayerMeta(textObject)
  setLayerMeta(textObject, {
    ...meta,
    richTextSource: markup,
    richTextFormat: 'tags',
  })
  textObject.setCoords()
}

function parseHtmlRichText(
  html: string,
  fallbackColor: string,
): {
  text: string
  styles: Record<number, Record<number, { fill?: string; textBackgroundColor?: string; textBackgroundRadius?: number; textBackgroundPaddingX?: number; textBackgroundPaddingY?: number; fontFamily?: string; fontSize?: number; fontWeight?: string; fontStyle?: string; underline?: boolean }>>
} {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  const styles: Record<number, Record<number, { fill?: string; textBackgroundColor?: string; textBackgroundRadius?: number; textBackgroundPaddingX?: number; textBackgroundPaddingY?: number; fontFamily?: string; fontSize?: number; fontWeight?: string; fontStyle?: string; underline?: boolean }>> = {}

  if (!root) {
    return { text: '', styles }
  }

  let output = ''
  let lineIndex = 0
  let charIndex = 0

  const appendText = (
    chunk: string,
    style: { fill?: string; textBackgroundColor?: string; textBackgroundRadius?: number; textBackgroundPaddingX?: number; textBackgroundPaddingY?: number; fontFamily?: string; fontSize?: number; fontWeight?: string; fontStyle?: string; underline?: boolean },
  ): void => {
    for (const char of chunk) {
      output += char
      if (char === '\n') {
        lineIndex += 1
        charIndex = 0
        continue
      }

      const hasStyle = Boolean(style.fill || style.textBackgroundColor || style.textBackgroundRadius || style.textBackgroundPaddingX || style.textBackgroundPaddingY || style.fontFamily || style.fontSize || style.fontWeight || style.fontStyle || style.underline)
      if (hasStyle) {
        styles[lineIndex] ??= {}
        styles[lineIndex][charIndex] = {
          ...(style.fill ? { fill: style.fill } : {}),
          ...(style.textBackgroundColor ? { textBackgroundColor: style.textBackgroundColor } : {}),
          ...(style.textBackgroundRadius ? { textBackgroundRadius: style.textBackgroundRadius } : {}),
          ...(style.textBackgroundPaddingX ? { textBackgroundPaddingX: style.textBackgroundPaddingX } : {}),
          ...(style.textBackgroundPaddingY ? { textBackgroundPaddingY: style.textBackgroundPaddingY } : {}),
          ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
          ...(style.fontSize ? { fontSize: style.fontSize } : {}),
          ...(style.fontWeight ? { fontWeight: style.fontWeight } : {}),
          ...(style.fontStyle ? { fontStyle: style.fontStyle } : {}),
          ...(style.underline ? { underline: true } : {}),
        }
      }

      charIndex += 1
    }
  }

  const walk = (
    node: Node,
    inherited: { fill?: string; textBackgroundColor?: string; textBackgroundRadius?: number; textBackgroundPaddingX?: number; textBackgroundPaddingY?: number; fontFamily?: string; fontSize?: number; fontWeight?: string; fontStyle?: string; underline?: boolean },
  ): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? '', inherited)
      return
    }

    if (!(node instanceof HTMLElement)) {
      return
    }

    if (node.tagName === 'BR') {
      appendText('\n', inherited)
      return
    }

    const style = { ...inherited }
    const tag = node.tagName.toLowerCase()

    if (tag === 'strong' || tag === 'b') style.fontWeight = 'bold'
    if (tag === 'em' || tag === 'i') style.fontStyle = 'italic'
    if (tag === 'u') style.underline = true

    const inlineColor = node.style.color
    const inlineBackgroundColor = node.style.backgroundColor
    const inlineBorderRadius = Number.parseFloat(node.style.borderRadius)
    const paddingParts = node.style.padding.split(/\s+/).filter(Boolean).map(Number.parseFloat)
    const inlinePaddingY = paddingParts[0]
    const inlinePaddingX = paddingParts[1] ?? paddingParts[0]
    const inlineFontSize = Number.parseFloat(node.style.fontSize)
    const inlineFontFamily = /^(['"]).*\1$/.test(node.style.fontFamily) ? node.style.fontFamily.slice(1, -1) : node.style.fontFamily
    const inlineWeight = node.style.fontWeight
    const inlineStyle = node.style.fontStyle
    const textDecoration = node.style.textDecoration

    if (inlineColor) style.fill = inlineColor
    if (inlineBackgroundColor) style.textBackgroundColor = inlineBackgroundColor
    if (Number.isFinite(inlineBorderRadius)) style.textBackgroundRadius = Math.max(0, inlineBorderRadius)
    if (Number.isFinite(inlinePaddingX)) style.textBackgroundPaddingX = Math.max(0, inlinePaddingX)
    if (Number.isFinite(inlinePaddingY)) style.textBackgroundPaddingY = Math.max(0, inlinePaddingY)
    if (Number.isFinite(inlineFontSize)) style.fontSize = Math.max(1, inlineFontSize)
    if (inlineFontFamily) style.fontFamily = inlineFontFamily
    if (inlineWeight) style.fontWeight = inlineWeight
    if (inlineStyle) style.fontStyle = inlineStyle
    if (textDecoration.includes('underline')) style.underline = true

    const hasBlockBreak = tag === 'p' || tag === 'div'
    if (hasBlockBreak && output.length > 0 && !output.endsWith('\n')) {
      appendText('\n', inherited)
    }

    Array.from(node.childNodes).forEach((child) => {
      walk(child, style)
    })
  }

  Array.from(root.childNodes).forEach((child) => {
    walk(child, { fill: fallbackColor })
  })

  const normalized = output.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
  if (normalized !== output) {
    // Re-run parser quickly with normalized text only; styles remain acceptable for current use.
    output = normalized
  }

  return { text: output, styles }
}

function applyRichTextToObject(
  textObject: FabricText | Textbox,
  richText: string,
  format: RichTextFormat,
): void {
  const fallbackFill = toHexColor(String((textObject as { fill?: unknown }).fill ?? '#1c2738'), '#1c2738')
  const parsed = format === 'html'
    ? parseHtmlRichText(richText, fallbackFill)
    : parseTaggedText(richText, fallbackFill)

  textObject.set({ text: parsed.text, styles: parsed.styles })
  const meta = getLayerMeta(textObject)
  setLayerMeta(textObject, {
    ...meta,
    richTextSource: richText,
    richTextFormat: format,
  })
  // Mudanças só de estilo (negrito, fonte, tamanho) não remedem o texto sozinhas.
  textObject.initDimensions()
  textObject.set('dirty', true)
  textObject.setCoords()
}

function textObjectToTagMarkup(textObject: FabricText | Textbox): string {
  const styles = (textObject as unknown as { styles?: Record<number, Record<number, { fill?: unknown }>> }).styles ?? {}
  const toHex = (value: unknown): string => {
    try { return `#${new FabricColor(String(value)).toHex().toLowerCase()}` } catch { return '' }
  }
  const base = toHex((textObject as { fill?: unknown }).fill ?? '#1c2738')
  let output = ''
  let open = ''
  String((textObject as { text?: unknown }).text ?? '').split('\n').forEach((line, lineIndex) => {
    if (lineIndex > 0) output += '\n'
    Array.from(line).forEach((character, charIndex) => {
      const fill = styles[lineIndex]?.[charIndex]?.fill
      const color = fill ? toHex(fill) : ''
      const next = color && color !== base ? color : ''
      if (next !== open) {
        if (open) output += `</${open}>`
        if (next) output += `<${next}>`
        open = next
      }
      output += character
    })
  })
  if (open) output += `</${open}>`
  return output
}

function createTextLayoutControls(
  textObject: FabricText | Textbox,
  commit: () => void,
): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const readMeta = (): LayerMeta => getLayerMeta(textObject)
  const apply = (changes: Partial<Pick<LayerMeta, 'textVerticalAlign' | 'textOverflow' | 'textBoxHeight'>>): void => {
    const meta = readMeta()
    const next = { ...meta, ...changes }
    const minimumHeight = Math.max(20, next.textBoxHeight ?? textObject.height ?? 40)
    setLayerMeta(textObject, { ...next, textBoxHeight: minimumHeight })
    textObject.initDimensions()
    textObject.setCoords()
    commit()
  }

  const horizontalAlign = document.createElement('select')
  ;([
    ['left', 'Esquerda'],
    ['center', 'Centro'],
    ['right', 'Direita'],
  ] as Array<[TextAlignMode, string]>).forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    const savedAlign = normalizeTextAlign((textObject as { textAlign?: unknown }).textAlign, 'left')
    option.selected = (savedAlign === 'justify' ? 'left' : savedAlign) === value
    horizontalAlign.append(option)
  })
  attachNoDragPropagation(horizontalAlign)
  horizontalAlign.addEventListener('change', () => {
    textObject.set({ textAlign: horizontalAlign.value as TextAlignMode })
    textObject.initDimensions()
    textObject.setCoords()
    commit()
  })
  fragment.append(detailsRow('Alinhamento horizontal', horizontalAlign))

  const verticalAlign = document.createElement('select')
  ;([
    ['top', 'Topo'],
    ['middle', 'Meio'],
    ['bottom', 'Base'],
  ] as Array<[TextVerticalAlignMode, string]>).forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = normalizeTextVerticalAlign(readMeta().textVerticalAlign) === value
    verticalAlign.append(option)
  })
  attachNoDragPropagation(verticalAlign)
  verticalAlign.addEventListener('change', () => apply({ textVerticalAlign: verticalAlign.value as TextVerticalAlignMode }))
  fragment.append(detailsRow('Alinhamento vertical', verticalAlign))

  const overflow = document.createElement('select')
  ;([
    ['expand', 'Expandir caixa'],
    ['clip', 'Cortar excedente'],
  ] as Array<[TextOverflowMode, string]>).forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = normalizeTextOverflow(readMeta().textOverflow) === value
    overflow.append(option)
  })
  attachNoDragPropagation(overflow)
  overflow.addEventListener('change', () => apply({ textOverflow: overflow.value as TextOverflowMode }))
  fragment.append(detailsRow('Texto excedente', overflow))

  if (textObject instanceof Textbox) {
    const width = document.createElement('input')
    width.type = 'number'
    width.min = '40'
    width.max = '800'
    width.step = '1'
    width.value = String(Math.round(textObject.width ?? 260))
    attachNoDragPropagation(width)
    width.addEventListener('change', () => {
      textObject.set({ width: clamp(40, 800, Number(width.value) || 260) })
      textObject.initDimensions()
      textObject.setCoords()
      commit()
    })
    fragment.append(detailsRow('Largura da caixa', width))

    const height = document.createElement('input')
    height.type = 'number'
    height.min = '20'
    height.max = '800'
    height.step = '1'
    height.value = String(Math.round(readMeta().textBoxHeight ?? textObject.height ?? 40))
    attachNoDragPropagation(height)
    height.addEventListener('change', () => apply({ textBoxHeight: clamp(20, 800, Number(height.value) || 40) }))
    fragment.append(detailsRow('Altura da caixa', height))
  }

  return fragment
}

function installRoundedTextBackgroundRenderer(): void {
  const prototype = FabricText.prototype as unknown as Record<string, unknown>
  const originalRenderer = prototype['_renderTextLinesBackground'] as ((ctx: CanvasRenderingContext2D) => void) | undefined
  if (!originalRenderer || prototype['_roundedTextBackgroundInstalled']) return

  prototype['_roundedTextBackgroundInstalled'] = true
  prototype['_renderTextLinesBackground'] = function (this: any, ctx: CanvasRenderingContext2D) {
    if (this.path || (!this.textBackgroundColor && !this.styleHas('textBackgroundColor'))) {
      originalRenderer.call(this, ctx)
      return
    }

    const originalFill = ctx.fillStyle
    const leftOffset = this._getLeftOffset()
    let lineTopOffset = this._getTopOffset()
    const drawRun = (x: number, y: number, width: number, height: number, color: string, radius: number, paddingX: number, paddingY: number) => {
      if (!color || width <= 0) return
      ctx.fillStyle = color
      x -= paddingX
      y -= paddingY
      width += paddingX * 2
      height += paddingY * 2
      const safeRadius = Math.min(Math.max(0, radius), width / 2, height / 2)
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, width, height, safeRadius)
      } else {
        ctx.rect(x, y, width, height)
      }
      ctx.fill()
    }

    for (let lineIndex = 0; lineIndex < this._textLines.length; lineIndex += 1) {
      const lineHeight = this.getHeightOfLine(lineIndex)
      if (!this.textBackgroundColor && !this.styleHas('textBackgroundColor', lineIndex)) {
        lineTopOffset += lineHeight
        continue
      }
      const line = this._textLines[lineIndex]
      const lineLeftOffset = this._getLineLeftOffset(lineIndex)
      const backgroundHeight = this.getHeightOfLineImpl(lineIndex)
      let runStart = 0
      let runWidth = 0
      let runColor = this.getValueOfPropertyAt(lineIndex, 0, 'textBackgroundColor') as string
      let runRadius = Number(this.getValueOfPropertyAt(lineIndex, 0, 'textBackgroundRadius')) || 0
      let runPaddingX = Number(this.getValueOfPropertyAt(lineIndex, 0, 'textBackgroundPaddingX')) || 0
      let runPaddingY = Number(this.getValueOfPropertyAt(lineIndex, 0, 'textBackgroundPaddingY')) || 0

      for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
        const bounds = this.__charBounds[lineIndex][charIndex]
        const color = this.getValueOfPropertyAt(lineIndex, charIndex, 'textBackgroundColor') as string
        const radius = Number(this.getValueOfPropertyAt(lineIndex, charIndex, 'textBackgroundRadius')) || 0
        const paddingX = Number(this.getValueOfPropertyAt(lineIndex, charIndex, 'textBackgroundPaddingX')) || 0
        const paddingY = Number(this.getValueOfPropertyAt(lineIndex, charIndex, 'textBackgroundPaddingY')) || 0
        if (color !== runColor || radius !== runRadius || paddingX !== runPaddingX || paddingY !== runPaddingY) {
          let x = leftOffset + lineLeftOffset + runStart
          if (this.direction === 'rtl') x = this.width - x - runWidth
          drawRun(x, lineTopOffset, runWidth, backgroundHeight, runColor, runRadius, runPaddingX, runPaddingY)
          runStart = bounds.left
          runWidth = bounds.width
          runColor = color
          runRadius = radius
          runPaddingX = paddingX
          runPaddingY = paddingY
        } else {
          runWidth += bounds.kernedWidth
        }
      }
      let x = leftOffset + lineLeftOffset + runStart
      if (this.direction === 'rtl') x = this.width - x - runWidth
      drawRun(x, lineTopOffset, runWidth, backgroundHeight, runColor, runRadius, runPaddingX, runPaddingY)
      lineTopOffset += lineHeight
    }
    ctx.fillStyle = originalFill
  }
}

installRoundedTextBackgroundRenderer()

function installTextBoxLayoutRenderer(): void {
  const textboxPrototype = Textbox.prototype as unknown as Record<string, unknown>
  const originalCreateControls = Textbox.createControls
  if (!textboxPrototype['_fixedTextBoxControlsInstalled']) {
    textboxPrototype['_fixedTextBoxControlsInstalled'] = true
    Textbox.createControls = () => {
      const controls = originalCreateControls.call(Textbox)
      const textControls = controls.controls
      const resizeHeight: typeof controlsUtils.changeHeight = (...args) => {
        const target = args[1].target as Textbox & { resizingTextBoxHeight?: boolean; data?: LayerMeta }
        target.resizingTextBoxHeight = true
        let changed = false
        try {
          changed = controlsUtils.changeHeight(...args)
        } finally {
          target.resizingTextBoxHeight = false
        }
        if (changed && target.data) {
          target.data.textBoxHeight = Math.max(20, target.height ?? 20)
          target.initDimensions()
          target.setCoords()
        }
        return changed
      }
      textControls.mt = new Control({ x: 0, y: -0.5, actionHandler: resizeHeight, actionName: 'resizing' })
      textControls.mb = new Control({ x: 0, y: 0.5, actionHandler: resizeHeight, actionName: 'resizing' })
      textControls.tl.visible = false
      textControls.tr.visible = false
      textControls.bl.visible = false
      textControls.br.visible = false
      return controls
    }
  }

  const originalInitDimensions = textboxPrototype['initDimensions'] as (() => void) | undefined
  if (originalInitDimensions && !textboxPrototype['_fixedTextBoxHeightInstalled']) {
    textboxPrototype['_fixedTextBoxHeightInstalled'] = true
    textboxPrototype['initDimensions'] = function (this: any): void {
      originalInitDimensions.call(this)
      const data = this.data as Partial<LayerMeta> | undefined
      if (!data || this.resizingTextBoxHeight) return

      const requestedHeight = Number(data.textBoxHeight)
      const minimumHeight = Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : this.height
      data.textBoxHeight = minimumHeight
      this.height = normalizeTextOverflow(data.textOverflow) === 'clip'
        ? minimumHeight
        : Math.max(minimumHeight, this.height)
    }
  }

  const textPrototype = FabricText.prototype as unknown as Record<string, unknown>
  const originalRender = textPrototype['_render'] as ((ctx: CanvasRenderingContext2D) => void) | undefined
  if (!originalRender || textPrototype['_textBoxLayoutRendererInstalled']) return

  textPrototype['_textBoxLayoutRendererInstalled'] = true
  textPrototype['_render'] = function (this: any, ctx: CanvasRenderingContext2D): void {
    const data = this.data as Partial<LayerMeta> | undefined
    if (!data) {
      originalRender.call(this, ctx)
      return
    }

    const boxWidth = Math.max(1, Number(this.width) || 1)
    const boxHeight = Math.max(1, Number(this.height) || 1)
    const contentHeight = Math.max(0, Number(this.calcTextHeight?.()) || boxHeight)
    const remainingHeight = Math.max(0, boxHeight - contentHeight)
    const verticalAlign = normalizeTextVerticalAlign(data.textVerticalAlign)
    const verticalOffset = verticalAlign === 'middle' ? remainingHeight / 2 : verticalAlign === 'bottom' ? remainingHeight : 0

    ctx.save()
    if (normalizeTextOverflow(data.textOverflow) === 'clip') {
      ctx.beginPath()
      ctx.rect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight)
      ctx.clip()
    }
    if (verticalOffset > 0) ctx.translate(0, verticalOffset)
    originalRender.call(this, ctx)
    ctx.restore()
  }
}

installTextBoxLayoutRenderer()

function wrapSelectionWithTag(textarea: HTMLTextAreaElement, tag: string): void {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  const before = textarea.value.slice(0, start)
  const selected = textarea.value.slice(start, end)
  const after = textarea.value.slice(end)
  const openTag = `<${tag}>`
  const closeTag = `</${tag}>`

  textarea.value = `${before}${openTag}${selected}${closeTag}${after}`
  textarea.focus()
  textarea.setSelectionRange(start + openTag.length, start + openTag.length + selected.length)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function wrapSelectionWithColor(textarea: HTMLTextAreaElement, colorToken: string, syntax: 'html' | 'bbcode'): void {
  if (syntax === 'bbcode') {
    const start = textarea.selectionStart ?? 0
    const end = textarea.selectionEnd ?? start
    const before = textarea.value.slice(0, start)
    const selected = textarea.value.slice(start, end)
    const after = textarea.value.slice(end)
    const openTag = `[cor=${colorToken}]`
    const closeTag = `[/cor]`

    textarea.value = `${before}${openTag}${selected}${closeTag}${after}`
    textarea.focus()
    textarea.setSelectionRange(start + openTag.length, start + openTag.length + selected.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  wrapSelectionWithTag(textarea, colorToken)
}

function loadSavedTextColors(): SavedTextStyle[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_TEXT_COLORS_KEY) ?? '[]')
    if (Array.isArray(saved)) {
      return DEFAULT_SAVED_TEXT_COLORS.map((fallback, index) => {
        const item = saved[index]
        if (typeof item === 'string') {
          return { color: DEFAULT_SAVED_TEXT_FOREGROUNDS[index], backgroundColor: item, borderRadius: 6, paddingX: 2, paddingY: 2, fontSize: 40 }
        }
        return {
          color: typeof item?.color === 'string' ? item.color : DEFAULT_SAVED_TEXT_FOREGROUNDS[index],
          backgroundColor: typeof item?.backgroundColor === 'string' ? item.backgroundColor : fallback,
          borderRadius: typeof item?.borderRadius === 'number' ? clamp(0, 24, item.borderRadius) : 6,
          paddingX: typeof item?.paddingX === 'number'
            ? clamp(0, 20, item.paddingX)
            : typeof item?.padding === 'number' ? clamp(0, 20, item.padding) : 2,
          paddingY: typeof item?.paddingY === 'number'
            ? clamp(0, 20, item.paddingY)
            : typeof item?.padding === 'number' ? clamp(0, 20, item.padding) : 2,
          fontSize: typeof item?.fontSize === 'number' ? clamp(8, 220, item.fontSize) : 40,
        }
      })
    }
  } catch {
    // Use defaults if browser storage is unavailable or contains invalid data.
  }
  return DEFAULT_SAVED_TEXT_COLORS.map((backgroundColor, index) => ({
    color: DEFAULT_SAVED_TEXT_FOREGROUNDS[index],
    backgroundColor,
    borderRadius: 6,
    paddingX: 2,
    paddingY: 2,
    fontSize: 40,
  }))
}

function saveTextColors(colors: SavedTextStyle[]): void {
  try {
    localStorage.setItem(SAVED_TEXT_COLORS_KEY, JSON.stringify(colors))
  } catch {
    // The palette still works for this session when storage is unavailable.
  }
}

function createSavedTextColorPalette(onApply: (style: SavedTextStyle) => void): HTMLDivElement {
  const styles = loadSavedTextColors()
  const palette = document.createElement('div')
  palette.className = 'saved-color-palette'

  styles.forEach((savedStyle, index) => {
    const slot = document.createElement('div')
    slot.className = 'saved-color-slot'
    const picker = document.createElement('input')
    picker.type = 'color'
    picker.value = savedStyle.color
    picker.title = `Cor do texto ${index + 1}`
    attachNoDragPropagation(picker)
    const backgroundPicker = document.createElement('input')
    backgroundPicker.type = 'color'
    backgroundPicker.value = savedStyle.backgroundColor
    backgroundPicker.title = `Cor de fundo ${index + 1}`
    attachNoDragPropagation(backgroundPicker)
    const radiusPicker = document.createElement('input')
    radiusPicker.type = 'number'
    radiusPicker.min = '0'
    radiusPicker.max = '24'
    radiusPicker.value = String(savedStyle.borderRadius)
    radiusPicker.title = `Arredondamento ${index + 1}`
    attachNoDragPropagation(radiusPicker)
    const paddingXPicker = document.createElement('input')
    paddingXPicker.type = 'number'
    paddingXPicker.min = '0'
    paddingXPicker.max = '20'
    paddingXPicker.value = String(savedStyle.paddingX)
    paddingXPicker.title = `Padding X ${index + 1}`
    attachNoDragPropagation(paddingXPicker)
    const paddingYPicker = document.createElement('input')
    paddingYPicker.type = 'number'
    paddingYPicker.min = '0'
    paddingYPicker.max = '20'
    paddingYPicker.value = String(savedStyle.paddingY)
    paddingYPicker.title = `Padding Y ${index + 1}`
    attachNoDragPropagation(paddingYPicker)
    const fontSizePicker = document.createElement('input')
    fontSizePicker.type = 'number'
    fontSizePicker.min = '8'
    fontSizePicker.max = '220'
    fontSizePicker.value = String(savedStyle.fontSize)
    fontSizePicker.title = `Tamanho da fonte ${index + 1}`
    attachNoDragPropagation(fontSizePicker)
    const applyButton = document.createElement('button')
    applyButton.type = 'button'
    applyButton.className = 'saved-color-apply'
    applyButton.textContent = `Aa ${index + 1}`
    applyButton.title = `Aplicar cor padrão ${index + 1}`
    const updatePreset = () => {
      savedStyle.color = picker.value
      savedStyle.backgroundColor = backgroundPicker.value
      savedStyle.borderRadius = clamp(0, 24, Number(radiusPicker.value) || 0)
      savedStyle.paddingX = clamp(0, 20, Number(paddingXPicker.value) || 0)
      savedStyle.paddingY = clamp(0, 20, Number(paddingYPicker.value) || 0)
      savedStyle.fontSize = clamp(8, 220, Number(fontSizePicker.value) || 40)
      applyButton.style.color = savedStyle.color
      applyButton.style.background = savedStyle.backgroundColor
      applyButton.style.borderRadius = `${savedStyle.borderRadius}px`
      applyButton.style.padding = `${savedStyle.paddingY}px ${savedStyle.paddingX}px`
      applyButton.style.fontSize = `${Math.min(24, Math.max(10, savedStyle.fontSize / 2))}px`
      saveTextColors(styles)
    }
    applyButton.addEventListener('click', () => onApply({ ...savedStyle }))
    picker.addEventListener('input', updatePreset)
    backgroundPicker.addEventListener('input', updatePreset)
    radiusPicker.addEventListener('input', updatePreset)
    paddingXPicker.addEventListener('input', updatePreset)
    paddingYPicker.addEventListener('input', updatePreset)
    fontSizePicker.addEventListener('input', updatePreset)
    updatePreset()
    slot.append(picker, backgroundPicker, radiusPicker, paddingXPicker, paddingYPicker, fontSizePicker, applyButton)
    palette.append(slot)
  })
  return palette
}

function sourceObjectBox(object: FabricObject): { width: number; height: number } {
  return {
    width: Math.max(1, Math.abs((object.width ?? 1) * (object.scaleX ?? 1))),
    height: Math.max(1, Math.abs((object.height ?? 1) * (object.scaleY ?? 1))),
  }
}

function naturalImageBox(image: FabricImage): { width: number; height: number } {
  const element = image.getElement() as CanvasImageSource & {
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
    width?: number
    height?: number
  }
  return {
    width: Math.max(1, element.naturalWidth ?? element.videoWidth ?? element.width ?? image.width ?? 1),
    height: Math.max(1, element.naturalHeight ?? element.videoHeight ?? element.height ?? image.height ?? 1),
  }
}

function applyImageFit(
  image: FabricImage,
  fit: ImageFitMode,
  targetWidth: number,
  targetHeight: number,
  cropPositionX = 0.5,
  cropPositionY = 0.5,
): void {
  const natural = naturalImageBox(image)
  const naturalWidth = natural.width
  const naturalHeight = natural.height

  image.set({
    cropX: 0,
    cropY: 0,
    width: naturalWidth,
    height: naturalHeight,
  })

  if (fit === 'fill') {
    image.set({ scaleX: targetWidth / naturalWidth, scaleY: targetHeight / naturalHeight })
    return
  }

  if (fit === 'cover') {
    const targetRatio = targetWidth / targetHeight
    const naturalRatio = naturalWidth / naturalHeight
    let cropWidth = naturalWidth
    let cropHeight = naturalHeight
    let cropX = 0
    let cropY = 0

    if (naturalRatio > targetRatio) {
      cropWidth = naturalHeight * targetRatio
      cropX = (naturalWidth - cropWidth) * clamp(0, 1, cropPositionX)
    } else {
      cropHeight = naturalWidth / targetRatio
      cropY = (naturalHeight - cropHeight) * clamp(0, 1, cropPositionY)
    }

    image.set({
      cropX,
      cropY,
      width: cropWidth,
      height: cropHeight,
      scaleX: targetWidth / cropWidth,
      scaleY: targetHeight / cropHeight,
    })
    return
  }

  let scale = 1
  if (fit === 'contain') {
    scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
  } else if (fit === 'scale-down') {
    scale = Math.min(1, Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight))
  }

  image.set({ scaleX: scale, scaleY: scale })
}

function applyImageFitForObject(object: FabricImage, fit: ImageFitMode): void {
  const meta = getLayerMeta(object)
  const target = {
    width: Math.max(1, meta.slotWidth ?? sourceObjectBox(object).width),
    height: Math.max(1, meta.slotHeight ?? sourceObjectBox(object).height),
  }

  applyImageFit(object, fit, target.width, target.height, meta.cropPositionX, meta.cropPositionY)
  setLayerMeta(object, { ...meta, fit, slotWidth: target.width, slotHeight: target.height })
}

async function replaceIllustrationOnObject(object: FabricImage, url: string, fit: ImageFitMode): Promise<void> {
  return withLoading(async () => {
    const meta = getLayerMeta(object)
    await object.setSrc(url)
    applyImageFitForObject(object, fit)
    setLayerMeta(object, { ...meta, fit, slotWidth: meta.slotWidth, slotHeight: meta.slotHeight })
    object.setCoords()
  })
}

function selectedEditableImageObject(): FabricImage | null {
  const activeObject = canvas.getActiveObject()
  if (!(activeObject instanceof FabricImage)) {
    return null
  }

  const meta = getLayerMeta(activeObject)
  if (meta.kind !== 'image') {
    return null
  }

  if (meta.scope !== activeEditMode && !(activeEditMode === 'deck' && meta.scope === 'model')) {
    return null
  }

  return activeObject
}

function openIllustrationUpload(): void {
  if (!selectedEditableImageObject()) {
    return
  }

  imageInput.click()
}

function createImageBehaviorControls(object: FabricImage): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const fitField = document.createElement('select')
  fitField.className = 'image-fit-select'
  const fitOptions: Array<{ value: ImageFitMode; label: string }> = [
    { value: 'cover', label: 'Cobrir área (cover)' },
    { value: 'contain', label: 'Conter imagem (contain)' },
    { value: 'fill', label: 'Esticar para preencher (fill)' },
    { value: 'none', label: 'Tamanho original (none)' },
    { value: 'scale-down', label: 'Reduzir se necessário (scale-down)' },
  ]
  const currentFit = normalizeImageFit(getLayerMeta(object).fit ?? 'contain')
  fitField.disabled = Boolean(getLayerMeta(object).locked || getLayerMeta(object).isBackground)
  fitOptions.forEach(({ value, label }) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = value === currentFit
    fitField.append(option)
  })
  attachNoDragPropagation(fitField)
  fitField.addEventListener('change', () => {
    const fit = normalizeImageFit(fitField.value, 'contain')
    if (fit !== 'cover' && cropPanLayerId === getLayerMeta(object).id) {
      cropPanLayerId = null
      canvas.upperCanvasEl.classList.remove('is-crop-panning')
    }
    applyImageFitForObject(object, fit)
    object.setCoords()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
    renderCardThumbnails()
    syncCropButton()
  })
  fragment.append(detailsRow('Ajuste da imagem', fitField))

  const fitHint = document.createElement('p')
  fitHint.className = 'layer-note image-fit-hint'
  fitHint.textContent = 'Cobrir recorta as bordas sem deformar; conter mostra a imagem inteira.'
  fragment.append(fitHint)

  const cropButton = document.createElement('button')
  cropButton.type = 'button'
  cropButton.className = 'ghost image-crop-button'
  attachNoDragPropagation(cropButton)
  const syncCropButton = (): void => {
    const layerId = getLayerMeta(object).id
    const enabled = normalizeImageFit(fitField.value, 'contain') === 'cover'
    const active = cropPanLayerId === layerId
    cropButton.disabled = !enabled || Boolean(getLayerMeta(object).locked || getLayerMeta(object).isBackground)
    cropButton.classList.toggle('is-active', active)
    cropButton.textContent = active ? 'Concluir enquadramento' : 'Arrastar enquadramento'
  }
  cropButton.addEventListener('click', () => {
    const layerId = getLayerMeta(object).id
    cropPanLayerId = cropPanLayerId === layerId ? null : layerId
    canvas.setActiveObject(object)
    canvas.upperCanvasEl.classList.toggle('is-crop-panning', cropPanLayerId === layerId)
    canvas.requestRenderAll()
    syncCropButton()
  })
  syncCropButton()
  fragment.append(detailsRow('Posição do recorte', cropButton))

  const fileField = document.createElement('input')
  fileField.type = 'file'
  fileField.accept = 'image/*'
  attachNoDragPropagation(fileField)
  fileField.addEventListener('change', async () => {
    const file = fileField.files?.[0]
    if (!file) return
    try {
      const dataUrl = await fileToObjectUrl(file)
      const selectedFit = normalizeImageFit(getLayerMeta(object).fit ?? fitField.value, 'contain')
      await replaceIllustrationOnObject(object, dataUrl, selectedFit)
      canvas.requestRenderAll()
      persistActiveDeckDocument()
      renderCardThumbnails()
    } catch {
      window.alert('Falha ao substituir a ilustracao desta carta.')
    } finally {
      fileField.value = ''
    }
  })
  fragment.append(detailsRow('Trocar imagem', fileField))

  const hint = document.createElement('p')
  hint.className = 'layer-note'
  hint.textContent = 'Em cover, ative “Arrastar enquadramento” e arraste a imagem. Dê duplo clique para trocar o arquivo.'
  fragment.append(hint)

  return fragment
}

function layerIdFromSerialized(object: unknown): string | null {
  if (!object || typeof object !== 'object') return null
  const data = (object as { data?: Partial<LayerMeta> }).data
  if (!data?.id) return null
  return data.id
}

function layerFitFromSerialized(object: unknown): ImageFitMode | undefined {
  if (!object || typeof object !== 'object') return undefined
  const data = (object as { data?: Partial<LayerMeta> }).data
  if (!isImageFitMode(data?.fit)) return undefined
  return data.fit
}

function collectCardModelOverrides(
  modelBaseObjects: unknown[],
  modelCurrentObjects: unknown[],
): Record<string, CardModelOverride> {
  const baseById = new Map<string, Record<string, unknown>>()
  for (const object of modelBaseObjects) {
    const id = layerIdFromSerialized(object)
    if (!id || typeof object !== 'object') continue
    baseById.set(id, object as Record<string, unknown>)
  }

  const overrides: Record<string, CardModelOverride> = {}

  for (const object of modelCurrentObjects) {
    if (!object || typeof object !== 'object') continue
    const current = object as Record<string, unknown>
    const id = layerIdFromSerialized(current)
    if (!id) continue

    const data = current['data'] as Partial<LayerMeta> | undefined
    const kind = data?.kind
    if (kind !== 'text' && kind !== 'image' && kind !== 'base') continue

    const base = baseById.get(id)
    if (!base) continue

    if (kind === 'text') {
      const currentText = String(current['text'] ?? '')
      const baseText = String(base['text'] ?? '')
      const currentData = current['data'] as Partial<LayerMeta> | undefined
      const baseData = base['data'] as Partial<LayerMeta> | undefined
      const currentRichText = typeof currentData?.richTextSource === 'string' ? currentData.richTextSource : ''
      const baseRichText = typeof baseData?.richTextSource === 'string' ? baseData.richTextSource : ''
      const currentRichTextFormat: RichTextFormat = currentData?.richTextFormat === 'html' ? 'html' : 'tags'
      const baseRichTextFormat: RichTextFormat = baseData?.richTextFormat === 'html' ? 'html' : 'tags'

      const textProps = diffCardTextProps(current, base)

      if (currentRichText && (currentRichText !== baseRichText || currentRichTextFormat !== baseRichTextFormat)) {
        overrides[id] = {
          richText: currentRichText,
          richTextFormat: currentRichTextFormat,
          text: currentText,
          ...(textProps ? { textProps } : {}),
        }
        continue
      }

      if (currentText !== baseText || textProps) {
        overrides[id] = {
          ...(currentText !== baseText ? { text: currentText } : {}),
          ...(textProps ? { textProps } : {}),
        }
      }
      continue
    }

    const currentSrc = typeof current['src'] === 'string' ? current['src'] : ''
    const baseSrc = typeof base['src'] === 'string' ? base['src'] : ''
    const hiddenChanged = kind === 'base' && current['visible'] !== base['visible']
    const hiddenOverride = kind === 'base' && typeof current['visible'] === 'boolean'
      ? { hidden: current['visible'] === false }
      : {}
    const currentFit = isImageFitMode(data?.fit) ? data.fit : undefined
    const baseData = base['data'] as Partial<LayerMeta> | undefined
    const currentCropX = typeof data?.cropPositionX === 'number' ? data.cropPositionX : 0.5
    const currentCropY = typeof data?.cropPositionY === 'number' ? data.cropPositionY : 0.5
    const baseCropX = typeof baseData?.cropPositionX === 'number' ? baseData.cropPositionX : 0.5
    const baseCropY = typeof baseData?.cropPositionY === 'number' ? baseData.cropPositionY : 0.5
    const cropChanged = Math.abs(currentCropX - baseCropX) > 0.0001 || Math.abs(currentCropY - baseCropY) > 0.0001
    const cropOverride = cropChanged ? { cropPositionX: currentCropX, cropPositionY: currentCropY } : {}
    if (currentSrc && currentSrc !== baseSrc) {
      overrides[id] = { src: currentSrc, fit: currentFit, ...cropOverride, ...hiddenOverride }
      continue
    }

    if (currentFit || cropChanged || hiddenChanged) {
      overrides[id] = { fit: currentFit, ...cropOverride, ...hiddenOverride }
    }
  }

  return overrides
}

function cloneCanvasState(state: ReturnType<Canvas['toObject']>): ReturnType<Canvas['toObject']> {
  return JSON.parse(JSON.stringify(state)) as ReturnType<Canvas['toObject']>
}

function createCardCanvasFromModel(model: CardModel): ReturnType<Canvas['toObject']> {
  const state = cloneCanvasState(model.canvas)
  const objects = (state.objects ?? []) as Array<Record<string, unknown>>
  return {
    ...state,
    objects: objects.map((object) => {
      const data = object['data'] as Partial<LayerMeta> | undefined
      const wasBase = data?.kind === 'base'
      return {
        ...object,
        data: {
          ...data,
          id: generateLayerId(),
          kind: wasBase ? 'image' : data?.kind,
          scope: 'deck',
          isBackground: wasBase || data?.isBackground === true,
        },
      }
    }) as ReturnType<Canvas['toObject']>['objects'],
  }
}

function currentDeck(): DeckDocument {
  const found = deckDocuments.find((deck) => deck.id === activeDeckId)
  if (!found) {
    if (deckDocuments.length === 0) {
      const deck = createDeckDocument()
      deckDocuments.push(deck)
      activeDeckId = deck.id
      return deck
    }

    activeDeckId = deckDocuments[0].id
    return deckDocuments[0]
  }

  return found
}

function captureCardThumbnail(): string {
  return canvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

function applyDeckModelImageFit(targetCanvas: Canvas): void {
  targetCanvas.getObjects().forEach((object) => {
    const meta = getLayerMeta(object)
    if (meta.kind !== 'image' || meta.scope !== 'model' || !(object instanceof FabricImage)) {
      return
    }

    // Keep model image slots stable for every render path (editor, thumbnails, print).
    const fit = meta.isBackground ? 'fill' : normalizeImageFit(meta.fit ?? 'contain')
    const targetWidth = meta.isBackground ? CARD_WIDTH : Math.max(1, meta.slotWidth ?? object.getScaledWidth?.() ?? object.width ?? 1)
    const targetHeight = meta.isBackground ? CARD_HEIGHT : Math.max(1, meta.slotHeight ?? object.getScaledHeight?.() ?? object.height ?? 1)

    applyImageFit(object, fit, targetWidth, targetHeight, meta.cropPositionX, meta.cropPositionY)
    setLayerMeta(object, { ...meta, fit, slotWidth: targetWidth, slotHeight: targetHeight })
    object.setCoords()
  })
}

async function captureDeckCardThumbnail(deck: DeckDocument, cardId: string): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(buildCardCanvasState(deck, cardId))
  applyDeckModelImageFit(thumbnailCanvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

async function captureBackThumbnail(back: CardBack): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(back.canvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

async function captureModelThumbnail(model: CardModel): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(model.canvas)
  applyDeckModelImageFit(thumbnailCanvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

async function refreshDeckThumbnails(deck: DeckDocument): Promise<void> {
  return withLoading(async () => {
    for (const card of deck.cards) {
      try {
        card.thumbnail = await captureDeckCardThumbnail(deck, card.id)
      } catch {
        card.thumbnail = ''
      }
    }

    for (const back of deck.backs) {
      try {
        back.thumbnail = await captureBackThumbnail(back)
      } catch {
        back.thumbnail = ''
      }
    }

    if (deck.id === activeDeckId && activeEditMode === 'deck') {
      renderCardThumbnails()
    }
  })
}

const HISTORY_LIMIT = 40
const history: { key: string; stack: string[]; index: number } = { key: '', stack: [], index: -1 }
let restoringHistory = false

function historyKey(): string {
  const deck = currentDeck()
  return [activeDeckId, activeEditMode, deck.activeCardId, deck.activeModelId, deck.activeBackId].join('|')
}

function recordHistory(snapshot: unknown): void {
  if (restoringHistory) return
  const serialized = JSON.stringify(snapshot)
  const key = historyKey()
  if (history.key !== key) {
    history.key = key
    history.stack = [serialized]
    history.index = 0
    return
  }
  if (history.stack[history.index] === serialized) return
  history.stack = history.stack.slice(0, history.index + 1)
  history.stack.push(serialized)
  if (history.stack.length > HISTORY_LIMIT) history.stack.shift()
  history.index = history.stack.length - 1
}

async function stepHistory(direction: -1 | 1): Promise<void> {
  if (history.key !== historyKey() || restoringHistory) return
  const target = history.index + direction
  if (target < 0 || target >= history.stack.length) return
  history.index = target
  restoringHistory = true
  try {
    await loadDeckCanvas(JSON.parse(history.stack[target]) as ReturnType<Canvas['toObject']>)
  } finally {
    restoringHistory = false
  }
  if (activeEditMode === 'deck') renderCardThumbnails()
}

function persistActiveDeckDocument(): void {
  const deck = currentDeck()
  const snapshot = canvas.toObject(['data'])
  recordHistory(snapshot)
  const all = (snapshot.objects ?? []) as Array<{ data?: Partial<LayerMeta> }>
  const modelObjects = all.filter(o => o.data?.scope === 'model') as unknown[]

  if (activeEditMode === 'back') {
    const back = activeBackOf(deck)
    back.canvas = { ...snapshot }
    try {
      back.thumbnail = captureCardThumbnail()
    } catch {
      back.thumbnail = ''
    }
    return
  }

  if (activeEditMode === 'model') {
    activeModelOf(deck).canvas = {
      ...snapshot,
      objects: modelObjects as ReturnType<Canvas['toObject']>['objects'],
    }
    return
  }

  const card = deck.cards.find(c => c.id === deck.activeCardId)
  if (card) {
    if (!card.canvas) {
      card.modelOverrides = collectCardModelOverrides(
        (modelOfCard(deck, card).canvas.objects ?? []) as unknown[],
        modelObjects,
      )
    }
    card.canvas = { ...snapshot }
    card.deckObjects = undefined
    try {
      card.thumbnail = captureCardThumbnail()
    } catch {
      card.thumbnail = ''
    }
  }
}

function buildCardCanvasState(deck: DeckDocument, cardId: string): ReturnType<Canvas['toObject']> {
  const card = deck.cards.find(c => c.id === cardId) ?? deck.cards[0]
  if (card?.canvas) return cloneCanvasState(card.canvas)
  const cardModelCanvas = modelOfCard(deck, card).canvas
  const modelObjects = deepClone((cardModelCanvas.objects ?? []) as Array<Record<string, unknown>>)

  for (const object of modelObjects) {
    const id = layerIdFromSerialized(object)
    if (!id) continue
    const override = card?.modelOverrides?.[id]
    if (!override) continue
    const objectData = object['data'] as Partial<LayerMeta> | undefined
    const kind = objectData?.kind

    if (kind === 'text') {
      if (typeof override.richText === 'string' && override.richText.length > 0) {
        const format: RichTextFormat = override.richTextFormat === 'html' ? 'html' : 'tags'
        const fallbackFill = toHexColor(typeof object['fill'] === 'string' ? object['fill'] : '#1c2738', '#1c2738')
        const parsed = format === 'html'
          ? parseHtmlRichText(override.richText, fallbackFill)
          : parseTaggedText(override.richText, fallbackFill)
        object['text'] = parsed.text
        object['styles'] = parsed.styles
      } else if (typeof override.text === 'string') {
        object['text'] = override.text
      }

      if (override.textProps) {
        const changed = { ...override.textProps } as Record<string, unknown>
        const existingData = object['data'] && typeof object['data'] === 'object'
          ? object['data'] as Record<string, unknown>
          : {}
        const nextData = { ...existingData }
        ;(['textVerticalAlign', 'textOverflow', 'textBoxHeight'] as const).forEach((key) => {
          if (Object.hasOwn(changed, key)) {
            nextData[key] = changed[key]
            delete changed[key]
          }
        })
        if (typeof nextData['textBoxHeight'] === 'number') {
          object['height'] = nextData['textOverflow'] === 'clip'
            ? nextData['textBoxHeight']
            : Math.max(Number(object['height']) || 0, nextData['textBoxHeight'])
        }
        Object.assign(object, changed)
        object['data'] = nextData
      }
    }

    if (kind === 'base' && typeof override.hidden === 'boolean') {
      object['visible'] = !override.hidden
    }

    if (typeof override.src === 'string' && override.src && override.src !== object['src']) {
      // Changing src: remove stale dimensions so Fabric.js uses the new image's natural size
      delete object['width']
      delete object['height']
      object['src'] = override.src
    } else if (typeof override.src === 'string' && override.src) {
      object['src'] = override.src
    }
    const overrideFit = override.fit ?? layerFitFromSerialized(object)
    const existingData = object['data'] as Record<string, unknown> | undefined
    const mergedData: Record<string, unknown> = {
      ...existingData,
      ...(overrideFit ? { fit: overrideFit } : {}),
      // preserve slot dimensions so loadDeckCanvas can reapply fit without recalculating
      ...(existingData?.['slotWidth'] != null ? { slotWidth: existingData['slotWidth'] } : {}),
      ...(existingData?.['slotHeight'] != null ? { slotHeight: existingData['slotHeight'] } : {}),
      ...(typeof override.cropPositionX === 'number' ? { cropPositionX: override.cropPositionX } : {}),
      ...(typeof override.cropPositionY === 'number' ? { cropPositionY: override.cropPositionY } : {}),
    }

    if (kind === 'text') {
      if (typeof override.richText === 'string' && override.richText.length > 0) {
        mergedData['richTextSource'] = override.richText
        mergedData['richTextFormat'] = override.richTextFormat === 'html' ? 'html' : 'tags'
      } else {
        delete mergedData['richTextSource']
        delete mergedData['richTextFormat']
      }
    }

    object['data'] = mergedData
  }

  return {
    ...cardModelCanvas,
    objects: [
      ...modelObjects,
      ...((card?.deckObjects ?? []) as ReturnType<Canvas['toObject']>['objects']),
    ],
  }
}

async function loadActiveDeckCard(deck: DeckDocument, cardId?: string): Promise<void> {
  const target = deck.cards.find(c => c.id === (cardId ?? deck.activeCardId)) ?? deck.cards[0]
  if (target) deck.activeCardId = target.id
  await loadDeckCanvas(buildCardCanvasState(deck, deck.activeCardId))
}

async function loadActiveModelIntoEditor(): Promise<void> {
  const deck = currentDeck()
  canvas.clear()
  layerById.clear()
  await canvas.loadFromJSON(activeModelOf(deck).canvas)
  syncCanvasFrame()
  canvas.getObjects().forEach(obj => {
    const meta = getLayerMeta(obj)
    if (meta.kind === 'base') setLayerMeta(obj, { ...meta, kind: 'image', isBackground: true })
    applyRuntimeConfig(obj)
  })
  refreshLayerIndex()
  renderLayersAccordion()
  canvas.discardActiveObject()
  canvas.requestRenderAll()
}

async function switchToModelView(): Promise<void> {
  if (activeEditMode === 'model') return
  persistActiveDeckDocument() // activeEditMode is 'deck' here → saves both model and card
  const deck = currentDeck()
  const activeCard = deck.cards.find(c => c.id === deck.activeCardId)
  deck.activeModelId = modelOfCard(deck, activeCard).id
  activeEditMode = 'model'
  activeRightPanelTab = 'model-layers'
  destroySelectedTextEditor()
  await loadActiveModelIntoEditor()
  renderWorkspaceTabs()
}

async function switchToCardView(): Promise<void> {
  if (activeEditMode === 'deck') return
  persistActiveDeckDocument() // activeEditMode is 'model' here → saves only modelCanvas
  activeEditMode = 'deck'
  activeRightPanelTab = 'cards'
  await loadActiveDeckCard(currentDeck())
  await refreshDeckThumbnails(currentDeck())
  renderWorkspaceTabs()
}

function normalizeScope(value: unknown, kind: LayerKind): LayerScope {
  if (value === 'model' || value === 'deck' || value === 'back') {
    return value
  }

  return kind === 'base' ? 'model' : activeEditMode
}

async function decompressDeckText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  if (
    bytes.length >= 2 &&
    bytes[0] === 0x1f &&
    bytes[1] === 0x8b &&
    typeof DecompressionStream !== 'undefined'
  ) {
    const compressed = new Blob([bytes])
    const decompressedStream = compressed.stream().pipeThrough(new DecompressionStream('gzip'))
    const decompressedBuffer = await new Response(decompressedStream).arrayBuffer()
    return new TextDecoder().decode(decompressedBuffer)
  }

  return new TextDecoder().decode(buffer)
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function markObjectScope(object: FabricObject, scope: LayerScope): void {
  const meta = getLayerMeta(object)
  setLayerMeta(object, { ...meta, scope })
}

function migrateDeckDocument(raw: Record<string, unknown>): DeckDocument {
  let models: CardModel[] = []
  let backs: CardBack[] = []
  let rawCards: Array<Partial<CardState>> = []

  if (Array.isArray(raw['models']) && Array.isArray(raw['cards'])) {
    models = (raw['models'] as Array<Partial<CardModel>>).map((m, i) => ({
      id: m.id || generateDeckId(),
      name: m.name || `Modelo ${i + 1}`,
      canvas: m.canvas || createEmptyCanvasState(),
    }))
    backs = (Array.isArray(raw['backs']) ? raw['backs'] as Array<Partial<CardBack>> : []).map((b, i) => ({
      id: b.id || generateDeckId(),
      name: b.name || `Verso ${i + 1}`,
      canvas: b.canvas || createEmptyCanvasState(),
      thumbnail: b.thumbnail || '',
    }))
    rawCards = raw['cards'] as Array<Partial<CardState>>
  } else if (raw['modelCanvas'] && Array.isArray(raw['cards'])) {
    models = [{ id: generateDeckId(), name: 'Modelo 1', canvas: raw['modelCanvas'] as ReturnType<Canvas['toObject']> }]
    backs = [{
      id: generateDeckId(),
      name: 'Verso 1',
      canvas: (raw['backCanvas'] as ReturnType<Canvas['toObject']> | undefined) || createEmptyCanvasState(),
      thumbnail: '',
    }]
    rawCards = raw['cards'] as Array<Partial<CardState>>
  } else {
    const oldCanvas = (raw['canvas'] ?? createEmptyCanvasState()) as ReturnType<Canvas['toObject']>
    const all = (oldCanvas.objects ?? []) as Array<{ data?: Partial<LayerMeta> }>
    models = [{
      id: generateDeckId(),
      name: 'Modelo 1',
      canvas: {
        ...oldCanvas,
        objects: all.filter(o => o.data?.scope === 'model') as ReturnType<Canvas['toObject']>['objects'],
      },
    }]
    rawCards = [{ deckObjects: all.filter(o => o.data?.scope !== 'model') as unknown[] }]
  }

  if (models.length === 0) models.push({ id: generateDeckId(), name: 'Modelo 1', canvas: createEmptyCanvasState() })
  if (backs.length === 0) backs.push({ id: generateDeckId(), name: 'Verso 1', canvas: createEmptyCanvasState(), thumbnail: '' })
  if (rawCards.length === 0) rawCards.push({})

  const cards: CardState[] = rawCards.map((card, index) => ({
    id: card.id || generateDeckId(),
    name: normalizeCardName(card.name || `Carta ${index + 1}`),
    canvas: card.canvas && typeof card.canvas === 'object' ? card.canvas as ReturnType<Canvas['toObject']> : undefined,
    deckObjects: Array.isArray(card.deckObjects) ? card.deckObjects : [],
    modelId: models.some(m => m.id === card.modelId) ? card.modelId as string : models[0].id,
    backId: backs.some(b => b.id === card.backId) ? card.backId as string : backs[0].id,
    modelOverrides: card.modelOverrides && typeof card.modelOverrides === 'object' ? card.modelOverrides : {},
    thumbnail: card.thumbnail || '',
  }))
  const requestedActive = typeof raw['activeCardId'] === 'string' ? raw['activeCardId'] : ''
  const activeCard = cards.find(c => c.id === requestedActive) ?? cards[0]

  const migratedDeck: DeckDocument = {
    id: (raw['id'] as string | undefined) ?? generateDeckId(),
    name: (raw['name'] as string | undefined) ?? DEFAULT_DECK_NAME,
    models,
    backs,
    library: (Array.isArray(raw['library']) ? raw['library'] as Array<Partial<LibraryAsset>> : [])
      .filter(a => typeof a.src === 'string' && a.src.length > 0)
      .map((a, i) => ({
        id: a.id || generateDeckId(),
        name: a.name || `Gráfico ${i + 1}`,
        src: a.src as string,
        width: typeof a.width === 'number' && a.width > 0 ? a.width : 0,
        height: typeof a.height === 'number' && a.height > 0 ? a.height : 0,
        scaleMode: a.scaleMode === 'nine-slice' ? 'nine-slice' : 'stretch',
        insetTop: Math.max(0, Number(a.insetTop) || 0),
        insetRight: Math.max(0, Number(a.insetRight) || 0),
        insetBottom: Math.max(0, Number(a.insetBottom) || 0),
        insetLeft: Math.max(0, Number(a.insetLeft) || 0),
      })),
    activeModelId: activeCard.modelId,
    activeBackId: activeCard.backId,
    cards,
    activeCardId: activeCard.id,
    cover: typeof raw['cover'] === 'string' ? raw['cover'] : '',
  }

  migratedDeck.cards.forEach((card) => {
    if (!card.canvas) card.canvas = buildCardCanvasState(migratedDeck, card.id)
    const objects = (card.canvas.objects ?? []) as Array<Record<string, unknown>>
    card.canvas = {
      ...card.canvas,
      objects: objects.map((object) => {
        const data = object['data'] as Partial<LayerMeta> | undefined
        const wasBase = data?.kind === 'base'
        return {
          ...object,
          data: {
            ...data,
            kind: wasBase ? 'image' : data?.kind,
            scope: 'deck',
            isBackground: wasBase || data?.isBackground === true,
          },
        }
      }) as ReturnType<Canvas['toObject']>['objects'],
    }
    card.deckObjects = []
    card.modelOverrides = {}
  })
  return migratedDeck
}

function deckFileSnapshot(): { version: 1; deck: DeckDocument } {
  persistActiveDeckDocument()
  const deck = currentDeck()

  return {
    version: 1,
    deck: {
      id: deck.id,
      name: deck.name,
      models: deck.models.map(m => ({ id: m.id, name: m.name, canvas: cloneCanvasState(m.canvas) })),
      backs: deck.backs.map(b => ({ id: b.id, name: b.name, canvas: cloneCanvasState(b.canvas), thumbnail: '' })),
      library: deck.library.map(a => ({ ...a })),
      activeModelId: deck.activeModelId,
      activeBackId: deck.activeBackId,
      cards: deck.cards.map(c => ({
        id: c.id,
        name: c.name,
        canvas: c.canvas ? cloneCanvasState(c.canvas) : undefined,
        modelId: c.modelId,
        backId: c.backId,
        modelOverrides: {},
        thumbnail: '',
      })),
      activeCardId: deck.activeCardId,
      cover: deck.cover ?? '',
    },
  }
}

app.innerHTML = `
<main id="editorWorkspace" class="editor-layout">
  <section class="panel tools-panel">
    <div class="left-panel-shell">
    <div class="menu-dropdown">
      <button id="mainMenuButton" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="mainMenuPanel">
        <span class="material-symbols-outlined" aria-hidden="true">menu</span>
        <span class="menu-trigger-label">Deck Studio</span>
        <span class="material-symbols-outlined menu-trigger-caret" aria-hidden="true">expand_more</span>
      </button>
      <div id="mainMenuPanel" class="menu-dropdown-panel menu-shell" hidden>
      <div class="menu-top">
        <button id="openTemplatesButton" class="template-launch-button" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">style</span>
          <span><strong>Modelos prontos</strong><small>Comece com uma carta completa</small></span>
        </button>
        <label class="file-name-field" for="deckNameInput">
          Nome do arquivo
          <input id="deckNameInput" type="text" placeholder="Baralho 1" aria-describedby="deckNameHint" />
        </label>
        <p id="deckNameHint" class="hint">A extensão .deck é adicionada ao salvar.</p>
        <button id="openPresetDecksButton" class="menu-item preset-decks-menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">style</span>
          <span>Decks prontos</span>
        </button>
        <div class="cover-field">
          <span class="cover-field-label">Capa do deck</span>
          <div class="cover-field-row">
            <div id="deckCoverPreview" class="cover-preview" aria-hidden="true"></div>
            <button id="deckCoverUploadButton" class="ghost tiny" type="button">Escolher</button>
            <button id="deckCoverRemoveButton" class="ghost tiny" type="button">Remover</button>
          </div>
          <input id="deckCoverInput" type="file" accept="image/*" hidden />
        </div>
        <p class="menu-caption">Ferramentas</p>
      </div>

      <nav class="menu-list" aria-label="Ferramentas do projeto">
        <button id="importDeckButton" class="menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
          <span>Abrir .deck</span>
        </button>
        <button id="exportDeckButton" class="menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">save</span>
          <span>Salvar .deck</span>
        </button>
        <button id="openTutorialButton" class="menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">school</span>
          <span>Como usar</span>
        </button>
      </nav>

      <div class="menu-footer">
        <label class="theme-switch" for="themeSwitch">
          <span class="theme-switch-label">
            <span id="themeIcon" class="material-symbols-outlined" aria-hidden="true">dark_mode</span>
            <span id="themeLabel">Modo escuro</span>
          </span>
          <input id="themeSwitch" type="checkbox" role="switch" aria-label="Ativar modo escuro" />
          <span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>
        </label>
        <button id="openPrintModalButton" class="menu-item menu-item-strong" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">print</span>
          <span>Gerar baralho</span>
        </button>
        <button id="exportPngButton" class="menu-cta" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">print</span>
          <span>Exportar Carta</span>
        </button>
      </div>
      <input id="importDeckInput" type="file" accept=".deck,application/octet-stream,application/gzip,application/json" hidden />
      </div>
    </div>

    <div class="left-scroll">
      <section id="editSection" class="edit-panel">
        <h2>Edição</h2>
        <p class="subtitle compact" id="editItemLabel">Selecione um item da carta para editar.</p>
        <div id="editPanelContent" class="edit-panel-content"></div>
      </section>
    </div>
    <div class="library-launcher">
      <button id="openAssetsButton" class="library-launch-button" type="button">
        <span class="material-symbols-outlined" aria-hidden="true">collections</span>
        <span>Assets</span>
      </button>
    </div>
    </div>
  </section>

  <div id="assetsModal" class="print-modal" hidden>
    <div id="assetsModalBackdrop" class="print-modal-backdrop"></div>
    <section class="print-modal-dialog assets-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="assetsModalTitle">
      <header class="print-modal-header">
        <h2 id="assetsModalTitle">Assets</h2>
        <button id="closeAssetsButton" class="ghost tiny" type="button" aria-label="Fechar assets">Fechar</button>
      </header>
      <div class="assets-modal-content">
        <div id="modelTools" class="model-tools">
          <div class="control-block">
            <h2>Adicionar layer</h2>
          <div class="row two">
            <button id="addGraphicButton" class="primary" type="button">+ Imagem</button>
            <button id="addTextButton" class="ghost" type="button">+ Texto</button>
          </div>
          <input id="imageInput" type="file" accept="image/*" hidden />
          <p class="hint">Para trocar uma imagem, selecione-a e dê duplo clique, ou use o painel de edição. Também dá para soltar imagens na carta.</p>
        </div>
          <div class="control-block">
            <h2>Formas</h2>
            <div id="shapePalette" class="shape-palette">
            <button class="ghost" type="button" data-shape="rect">Retângulo</button>
            <button class="ghost" type="button" data-shape="rounded">Arredondado</button>
            <button class="ghost" type="button" data-shape="ellipse">Círculo</button>
            <button class="ghost" type="button" data-shape="triangle">Triângulo</button>
            <button class="ghost" type="button" data-shape="diamond">Losango</button>
            <button class="ghost" type="button" data-shape="pentagon">Pentágono</button>
            <button class="ghost" type="button" data-shape="hexagon">Hexágono</button>
            <button class="ghost" type="button" data-shape="star">Estrela</button>
            <button class="ghost" type="button" data-shape="line">Linha</button>
            </div>
            <p class="hint">Selecione a forma e edite preenchimento, contorno, cantos e tamanho no painel de edição.</p>
          </div>
        </div>
        <section class="assets-library">
          <div class="library-modal-toolbar">
            <div><h3>Biblioteca gráfica</h3><p id="libraryHint" class="hint"></p></div>
            <button id="libraryUploadButton" class="primary" type="button">+ Adicionar à biblioteca</button>
            <input id="libraryInput" type="file" accept="image/*" multiple hidden />
          </div>
          <div id="libraryGrid" class="library-grid"></div>
        </section>
      </div>
    </section>
  </div>

  <div id="leftPanelResizer" class="panel-resizer" role="separator" aria-label="Redimensionar painel de ferramentas" aria-orientation="vertical" tabindex="0"></div>

  <section class="panel canvas-panel">
    <div id="canvasCoverBg" class="canvas-cover-bg" aria-hidden="true"></div>
    <div class="cover-switch" role="group" aria-label="Capa no fundo">
      <button type="button" data-cover-mode="off" title="Sem capa">Off</button>
      <button type="button" data-cover-mode="cover" title="Capa no fundo">Capa</button>
      <button type="button" data-cover-mode="blur" title="Capa com blur">Blur</button>
    </div>
    <div class="zoom-controls">
      <button id="zoomOutButton" class="ghost tiny" type="button" aria-label="Diminuir zoom">-</button>
      <input id="zoomRange" type="range" min="20" max="400" step="5" value="100" />
      <span id="zoomLabel" class="zoom-label">100%</span>
      <button id="zoomInButton" class="ghost tiny" type="button" aria-label="Aumentar zoom">+</button>
      <button id="zoomFitButton" class="ghost tiny zoom-fit-button" type="button" aria-label="Ajustar carta sem rolagem" title="Ajustar carta">
        <span class="material-symbols-outlined" aria-hidden="true">fit_screen</span>
      </button>
    </div>
    <div id="canvasStage" class="canvas-stage" aria-label="Editor visual da carta">
      <canvas id="cardCanvas" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"></canvas>
    </div>
  </section>

  <div id="deckPanelResizer" class="panel-resizer deck-panel-resizer" role="separator" aria-label="Redimensionar coluna de cartas" aria-orientation="vertical" tabindex="0"></div>

  <section id="cardsSection" class="panel cards-panel deck-preview-panel">
    <header class="deck-preview-header">
      <div>
        <h2>Baralho / Deck</h2>
        <p class="subtitle compact" id="cardCountLabel"></p>
      </div>
      <button id="addCardButton" class="primary tiny" type="button" aria-label="Adicionar carta" title="Adicionar carta">+</button>
    </header>
    <div id="cardThumbnails" class="card-thumbnails"></div>
  </section>

  <div id="rightPanelResizer" class="panel-resizer" role="separator" aria-label="Redimensionar painel lateral" aria-orientation="vertical" tabindex="0"></div>

  <div class="right-panel-host">
    <div class="right-panel-tab-bar">
      <button id="editDeckButton" class="tab-button is-active" type="button" role="switch" aria-checked="true" aria-label="Ocultar coluna Baralho" title="Ocultar coluna Baralho">Baralho</button>
      <button id="editModelButton" class="tab-button" type="button">Modelo</button>
      <button id="editBackButton" class="tab-button" type="button" title="Background (verso das cartas)">Verso</button>
    </div>
    <section id="layersSection" class="panel layers-panel" hidden>
      <h2 id="layersSectionTitle">Modelo</h2>
      <div id="cardVariantControls" class="card-variant-controls" hidden>
        <label>Modelo desta carta<select id="cardModelSelect"></select></label>
        <label>Verso desta carta<select id="cardBackSelect"></select></label>
      </div>
      <div id="variantBar" class="variant-bar">
        <input id="variantNameInput" type="text" maxlength="60" aria-label="Nome" placeholder="Nome" />
        <select id="variantSelect" aria-label="Selecionar variação"></select>
        <div class="variant-actions">
          <button id="variantNewButton" class="ghost tiny" type="button">+ Novo</button>
          <button id="variantDuplicateButton" class="ghost tiny" type="button">Duplicar</button>
          <button id="variantDeleteButton" class="danger tiny" type="button">Excluir</button>
        </div>
      </div>
      <h3 class="layers-heading">Layers</h3>
      <p class="subtitle compact">Reordene tambem arrastando os blocos.</p>
      <div id="layersAccordion" class="layers-accordion"></div>
    </section>
  </div>
</main>

<section id="tutorialSection" class="tutorial-section" aria-labelledby="tutorialTitle">
  <div class="tutorial-shell">
    <header class="tutorial-hero">
      <div>
        <span class="tutorial-eyebrow">GUIA RÁPIDO • DECK STUDIO</span>
        <h2 id="tutorialTitle">Da primeira ideia ao baralho impresso</h2>
        <p>Aprenda o fluxo essencial do editor e monte cartas consistentes sem precisar começar do zero.</p>
      </div>
      <span class="material-symbols-outlined tutorial-hero-icon" aria-hidden="true">auto_stories</span>
    </header>

    <div class="tutorial-steps">
      <article class="tutorial-step">
        <span class="tutorial-step-number">01</span>
        <div><h3>Escolha um modelo</h3><p>Clique em <strong>Modelos prontos</strong> para criar uma estrutura inicial. Cada carta recebe sua própria cópia dos layers.</p></div>
      </article>
      <article class="tutorial-step">
        <span class="tutorial-step-number">02</span>
        <div><h3>Ajuste a estrutura</h3><p>Na aba <strong>Modelo</strong>, edite a referência usada ao criar cartas. Alterações no modelo não afetam cartas existentes.</p></div>
      </article>
      <article class="tutorial-step">
        <span class="tutorial-step-number">03</span>
        <div><h3>Personalize cada carta</h3><p>Volte para <strong>Baralho</strong>, escolha uma miniatura e edite o conteúdo. Dê duplo clique na ilustração para substituí-la sem alterar seu encaixe.</p></div>
      </article>
      <article class="tutorial-step">
        <span class="tutorial-step-number">04</span>
        <div><h3>Crie variações</h3><p>Use <strong>Adicionar carta</strong> para gerar novas cartas com o mesmo modelo. Textos e imagens podem ser diferentes em cada uma.</p></div>
      </article>
      <article class="tutorial-step">
        <span class="tutorial-step-number">05</span>
        <div><h3>Prepare o verso</h3><p>Abra a aba <strong>Verso</strong> para criar a arte comum do baralho. Você pode enviar uma imagem base e adicionar outros elementos por cima.</p></div>
      </article>
      <article class="tutorial-step">
        <span class="tutorial-step-number">06</span>
        <div><h3>Salve e exporte</h3><p>Salve o projeto em <strong>.deck</strong> para continuar depois. Exporte uma carta individual ou use <strong>Gerar baralho</strong> para produzir PDF ou ZIP.</p></div>
      </article>
    </div>

    <div class="tutorial-tips">
      <h3><span class="material-symbols-outlined" aria-hidden="true">lightbulb</span> Dicas úteis</h3>
      <ul>
        <li>Use o controle de zoom ou mantenha <kbd>Ctrl</kbd> pressionado e mova a roda do mouse.</li>
        <li>Arraste imagens diretamente para a área da carta.</li>
        <li>Use as setas do teclado para ajustes finos e <kbd>Delete</kbd> para remover o layer selecionado.</li>
        <li>Antes de imprimir, confira o tamanho da carta, o papel, o espaçamento e a opção de verso.</li>
      </ul>
    </div>
  </div>
</section>

<button id="backToEditorButton" class="back-to-editor" type="button" aria-label="Voltar ao editor" aria-hidden="true" tabindex="-1">
  <span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
  <span>Voltar ao editor</span>
</button>

<div id="presetDecksModal" class="print-modal" hidden>
  <div id="presetDecksBackdrop" class="print-modal-backdrop"></div>
  <section class="print-modal-dialog preset-decks-dialog" role="dialog" aria-modal="true" aria-labelledby="presetDecksTitle">
    <header class="print-modal-header">
      <h2 id="presetDecksTitle">Decks prontos</h2>
      <button id="closePresetDecksButton" class="ghost tiny" type="button" aria-label="Fechar modal">Fechar</button>
    </header>
    <ul id="presetDeckList" class="preset-deck-grid"></ul>
  </section>
</div>

<div id="printModal" class="print-modal" hidden>
  <div id="printModalBackdrop" class="print-modal-backdrop"></div>
  <section class="print-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="printModalTitle">
    <header class="print-modal-header">
      <h2 id="printModalTitle">Gerar Baralho</h2>
      <button id="closePrintModalButton" class="ghost tiny" type="button" aria-label="Fechar modal">Fechar</button>
    </header>

    <div class="print-modal-body">
      <label>
        Formato da carta
        <select id="printCardSizeSelect">
          <option value="tcg">63 x 88 mm (TCG)</option>
          <option value="yugioh">59 x 86 mm (Yu-Gi-Oh)</option>
          <option value="poker">63 x 89 mm (Poker)</option>
          <option value="uno">56 x 87 mm (UNO)</option>
          <option value="uno-itu">100 x 150 mm (UNO ITU)</option>
          <option value="euro-standard">59 x 92 mm (Euro Standard)</option>
          <option value="euro-mini">44 x 68 mm (Euro Mini)</option>
          <option value="taro">70 x 120 mm (Taro)</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      <div id="printCustomSizeRow" class="row two" hidden>
        <label>
          Largura (mm)
          <input id="printCardWidthInput" type="number" min="10" max="300" step="1" value="63" />
        </label>
        <label>
          Altura (mm)
          <input id="printCardHeightInput" type="number" min="10" max="300" step="1" value="88" />
        </label>
      </div>

      <label>
        Formato da folha
        <select id="printPaperSizeSelect">
          <option value="a4">A4 (210 x 297 mm)</option>
          <option value="a3">A3 (297 x 420 mm)</option>
          <option value="a5">A5 (148 x 210 mm)</option>
          <option value="letter">Carta (216 x 279 mm)</option>
          <option value="oficio">Oficio (216 x 330 mm)</option>
        </select>
      </label>

      <label>
        Orientacao da folha
        <select id="printOrientationSelect">
          <option value="portrait">Retrato</option>
          <option value="landscape">Paisagem</option>
        </select>
      </label>

      <label>
        Gap entre cartas (mm)
        <input id="printGapInput" type="number" min="0" max="30" step="1" value="3" />
      </label>

      <fieldset class="print-cut-guide">
        <legend>Linha auxiliar de corte</legend>
        <label class="print-option-switch" for="printCutLineEnabled">
          <span>
            <span class="print-option-title">Mostrar linha de corte</span>
            <span class="print-option-description">Desenha uma linha ao redor de cada carta marcando onde cortar.</span>
          </span>
          <input id="printCutLineEnabled" type="checkbox" role="switch" checked />
          <span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>
        </label>
        <div id="printCutLineOptions" class="print-cut-guide-options">
          <label>
            Espessura (mm)
            <input id="printCutLineWidth" type="number" min="0.1" max="2" step="0.1" value="0.2" />
          </label>
          <label>
            Cor
            <input id="printCutLineColor" type="color" value="#000000" />
          </label>
          <label>
            Estilo
            <select id="printCutLineStyle">
              <option value="dotted" selected>Pontilhada</option>
              <option value="dashed">Tracejada</option>
              <option value="solid">Sólida</option>
            </select>
          </label>
        </div>
      </fieldset>

      <label class="print-option-switch" for="printIncludeBackSwitch">
        <span>
          <span class="print-option-title">Imprimir verso das cartas</span>
          <span class="print-option-description">Adiciona folhas de verso espelhadas para impressao frente e verso.</span>
        </span>
        <input id="printIncludeBackSwitch" type="checkbox" role="switch" checked />
        <span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>
      </label>

      <p id="printLayoutSummary" class="hint"></p>

      <div class="print-preview-wrap">
        <div id="printPreviewSheet" class="print-preview-sheet">
          <div id="printPreviewGrid" class="print-preview-grid"></div>
        </div>
      </div>

      <div class="print-modal-actions">
        <button id="generateDeckPrintPdfButton" class="primary" type="button">Baixar Baralho em PDF</button>
        <button id="generateDeckPrintZipButton" class="ghost" type="button">Baixar Baralho em ZIP</button>
      </div>
    </div>
  </section>
</div>

<div id="templatesModal" class="templates-modal" hidden>
  <div id="templatesModalBackdrop" class="templates-modal-backdrop"></div>
  <section class="templates-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="templatesModalTitle">
    <header class="templates-modal-header">
      <div>
        <span class="templates-eyebrow">BIBLIOTECA DE MODELOS</span>
        <h2 id="templatesModalTitle">Escolha um ponto de partida</h2>
        <p>Todos os elementos continuam editáveis depois da aplicação.</p>
      </div>
      <button id="closeTemplatesModalButton" class="ghost tiny" type="button" aria-label="Fechar modelos">Fechar</button>
    </header>
    <div id="templatesGrid" class="templates-grid"></div>
    <footer class="templates-modal-footer">
      <span class="material-symbols-outlined" aria-hidden="true">info</span>
      Aplicar um modelo substitui apenas o layout da frente. Suas cartas permanecem no baralho.
    </footer>
  </section>
</div>

<div id="confirmModal" class="templates-modal" hidden>
  <div id="confirmModalBackdrop" class="templates-modal-backdrop"></div>
  <section class="templates-modal-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle">
    <h2 id="confirmModalTitle"></h2>
    <p id="confirmModalMessage"></p>
    <label id="confirmModalChoiceWrap" class="confirm-choice" hidden>
      <span id="confirmModalChoiceLabel"></span>
      <select id="confirmModalChoice"></select>
    </label>
    <div class="dialog-actions">
      <button id="confirmModalCancel" class="ghost" type="button">Cancelar</button>
      <button id="confirmModalAccept" class="danger" type="button">Confirmar</button>
    </div>
  </section>
</div>

<div id="newCardModal" class="templates-modal" hidden>
  <div id="newCardModalBackdrop" class="templates-modal-backdrop"></div>
  <section class="templates-modal-dialog new-card-dialog" role="dialog" aria-modal="true" aria-labelledby="newCardModalTitle">
    <h2 id="newCardModalTitle">Nova carta</h2>
    <h3>Modelo</h3>
    <div id="newCardModels" class="variant-picker"></div>
    <h3>Verso</h3>
    <div id="newCardBacks" class="variant-picker"></div>
    <div class="dialog-actions">
      <button id="newCardCancel" class="ghost" type="button">Cancelar</button>
      <button id="newCardCreate" class="primary" type="button">Criar carta</button>
    </div>
  </section>
</div>

<div id="assetPickerModal" class="templates-modal" hidden>
  <div id="assetPickerBackdrop" class="templates-modal-backdrop"></div>
  <section class="templates-modal-dialog asset-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="assetPickerTitle">
    <h2 id="assetPickerTitle">Substituir asset</h2>
    <p class="layer-note">Duplo clique em um asset ou selecione e confirme.</p>
    <div id="assetPickerList" class="variant-picker asset-picker-list"></div>
    <div class="dialog-actions">
      <button id="assetPickerCancel" class="ghost" type="button">Cancelar</button>
      <button id="assetPickerConfirm" class="primary" type="button" disabled>Confirmar</button>
    </div>
  </section>
</div>
`

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) {
    throw new Error(`Elemento obrigatorio ausente: ${selector}`)
  }
  return found
}

const addTextButton = requireElement<HTMLButtonElement>(app, '#addTextButton')
const shapePalette = requireElement<HTMLDivElement>(app, '#shapePalette')
const openAssetsButton = requireElement<HTMLButtonElement>(app, '#openAssetsButton')
const libraryLauncher = requireElement<HTMLDivElement>(app, '.library-launcher')
const assetsModal = requireElement<HTMLDivElement>(app, '#assetsModal')
const assetsModalBackdrop = requireElement<HTMLDivElement>(app, '#assetsModalBackdrop')
const closeAssetsButton = requireElement<HTMLButtonElement>(app, '#closeAssetsButton')
const libraryUploadButton = requireElement<HTMLButtonElement>(app, '#libraryUploadButton')
const libraryInput = requireElement<HTMLInputElement>(app, '#libraryInput')
const libraryGrid = requireElement<HTMLDivElement>(app, '#libraryGrid')
const libraryHint = requireElement<HTMLParagraphElement>(app, '#libraryHint')
const addGraphicButton = requireElement<HTMLButtonElement>(app, '#addGraphicButton')
const imageInput = requireElement<HTMLInputElement>(app, '#imageInput')
const layersSectionTitle = requireElement<HTMLHeadingElement>(app, '#layersSectionTitle')
const variantSelect = requireElement<HTMLSelectElement>(app, '#variantSelect')
const variantNewButton = requireElement<HTMLButtonElement>(app, '#variantNewButton')
const variantDuplicateButton = requireElement<HTMLButtonElement>(app, '#variantDuplicateButton')
const variantNameInput = requireElement<HTMLInputElement>(app, '#variantNameInput')
const confirmModalChoiceWrap = requireElement<HTMLLabelElement>(app, '#confirmModalChoiceWrap')
const confirmModalChoiceLabel = requireElement<HTMLSpanElement>(app, '#confirmModalChoiceLabel')
const confirmModalChoice = requireElement<HTMLSelectElement>(app, '#confirmModalChoice')
const variantDeleteButton = requireElement<HTMLButtonElement>(app, '#variantDeleteButton')
const cardModelSelect = requireElement<HTMLSelectElement>(app, '#cardModelSelect')
const cardBackSelect = requireElement<HTMLSelectElement>(app, '#cardBackSelect')
const confirmModal = requireElement<HTMLDivElement>(app, '#confirmModal')
const confirmModalBackdrop = requireElement<HTMLDivElement>(app, '#confirmModalBackdrop')
const confirmModalTitle = requireElement<HTMLHeadingElement>(app, '#confirmModalTitle')
const confirmModalMessage = requireElement<HTMLParagraphElement>(app, '#confirmModalMessage')
const confirmModalCancel = requireElement<HTMLButtonElement>(app, '#confirmModalCancel')
const confirmModalAccept = requireElement<HTMLButtonElement>(app, '#confirmModalAccept')
const newCardModal = requireElement<HTMLDivElement>(app, '#newCardModal')
const newCardModalBackdrop = requireElement<HTMLDivElement>(app, '#newCardModalBackdrop')
const assetPickerModal = requireElement<HTMLDivElement>(app, '#assetPickerModal')
const assetPickerBackdrop = requireElement<HTMLDivElement>(app, '#assetPickerBackdrop')
const assetPickerList = requireElement<HTMLDivElement>(app, '#assetPickerList')
const assetPickerCancel = requireElement<HTMLButtonElement>(app, '#assetPickerCancel')
const assetPickerConfirm = requireElement<HTMLButtonElement>(app, '#assetPickerConfirm')
const newCardModels = requireElement<HTMLDivElement>(app, '#newCardModels')
const newCardBacks = requireElement<HTMLDivElement>(app, '#newCardBacks')
const newCardCancel = requireElement<HTMLButtonElement>(app, '#newCardCancel')
const newCardCreate = requireElement<HTMLButtonElement>(app, '#newCardCreate')
const exportDeckButton = requireElement<HTMLButtonElement>(app, '#exportDeckButton')
const deckNameInput = requireElement<HTMLInputElement>(app, '#deckNameInput')
const importDeckButton = requireElement<HTMLButtonElement>(app, '#importDeckButton')
const presetDeckList = requireElement<HTMLUListElement>(app, '#presetDeckList')
const deckCoverInput = requireElement<HTMLInputElement>(app, '#deckCoverInput')
const deckCoverUploadButton = requireElement<HTMLButtonElement>(app, '#deckCoverUploadButton')
const deckCoverRemoveButton = requireElement<HTMLButtonElement>(app, '#deckCoverRemoveButton')
const deckCoverPreview = requireElement<HTMLDivElement>(app, '#deckCoverPreview')
const canvasCoverBg = requireElement<HTMLDivElement>(app, '#canvasCoverBg')
const coverSwitchButtons = Array.from(app.querySelectorAll<HTMLButtonElement>('.cover-switch button'))
const presetDecksModal = requireElement<HTMLDivElement>(app, '#presetDecksModal')
const openPresetDecksButton = requireElement<HTMLButtonElement>(app, '#openPresetDecksButton')
const closePresetDecksButton = requireElement<HTMLButtonElement>(app, '#closePresetDecksButton')
const presetDecksBackdrop = requireElement<HTMLDivElement>(app, '#presetDecksBackdrop')
const importDeckInput = requireElement<HTMLInputElement>(app, '#importDeckInput')
const editModelButton = requireElement<HTMLButtonElement>(app, '#editModelButton')
const editBackButton = requireElement<HTMLButtonElement>(app, '#editBackButton')
const editDeckButton = requireElement<HTMLButtonElement>(app, '#editDeckButton')
const mainMenuButton = requireElement<HTMLButtonElement>(app, '#mainMenuButton')
const mainMenuPanel = requireElement<HTMLDivElement>(app, '#mainMenuPanel')
const openPrintModalButton = requireElement<HTMLButtonElement>(app, '#openPrintModalButton')
const printModal = requireElement<HTMLDivElement>(app, '#printModal')
const printModalBackdrop = requireElement<HTMLDivElement>(app, '#printModalBackdrop')
const closePrintModalButton = requireElement<HTMLButtonElement>(app, '#closePrintModalButton')
const printCardSizeSelect = requireElement<HTMLSelectElement>(app, '#printCardSizeSelect')
const printCustomSizeRow = requireElement<HTMLDivElement>(app, '#printCustomSizeRow')
const printCardWidthInput = requireElement<HTMLInputElement>(app, '#printCardWidthInput')
const printCardHeightInput = requireElement<HTMLInputElement>(app, '#printCardHeightInput')
const printPaperSizeSelect = requireElement<HTMLSelectElement>(app, '#printPaperSizeSelect')
const printOrientationSelect = requireElement<HTMLSelectElement>(app, '#printOrientationSelect')
const printGapInput = requireElement<HTMLInputElement>(app, '#printGapInput')
const printIncludeBackSwitch = requireElement<HTMLInputElement>(app, '#printIncludeBackSwitch')
const printCutLineEnabled = requireElement<HTMLInputElement>(app, '#printCutLineEnabled')
const printCutLineOptions = requireElement<HTMLDivElement>(app, '#printCutLineOptions')
const printCutLineWidth = requireElement<HTMLInputElement>(app, '#printCutLineWidth')
const printCutLineColor = requireElement<HTMLInputElement>(app, '#printCutLineColor')
const printCutLineStyle = requireElement<HTMLSelectElement>(app, '#printCutLineStyle')
const printLayoutSummary = requireElement<HTMLParagraphElement>(app, '#printLayoutSummary')
const printPreviewSheet = requireElement<HTMLDivElement>(app, '#printPreviewSheet')
const printPreviewGrid = requireElement<HTMLDivElement>(app, '#printPreviewGrid')
const generateDeckPrintZipButton = requireElement<HTMLButtonElement>(app, '#generateDeckPrintZipButton')
const generateDeckPrintPdfButton = requireElement<HTMLButtonElement>(app, '#generateDeckPrintPdfButton')
const exportPngButton = requireElement<HTMLButtonElement>(app, '#exportPngButton')
const canvasStage = requireElement<HTMLDivElement>(app, '#canvasStage')
const canvasPanel = requireElement<HTMLElement>(app, '.canvas-panel')
const layersSection = requireElement<HTMLElement>(app, '#layersSection')
const cardVariantControls = requireElement<HTMLDivElement>(app, '#cardVariantControls')
const variantBar = requireElement<HTMLDivElement>(app, '#variantBar')
const editItemLabel = requireElement<HTMLParagraphElement>(app, '#editItemLabel')
const editPanelContent = requireElement<HTMLDivElement>(app, '#editPanelContent')
const cardsSection = requireElement<HTMLElement>(app, '#cardsSection')
const cardThumbnails = requireElement<HTMLDivElement>(app, '#cardThumbnails')
const cardCountLabel = requireElement<HTMLParagraphElement>(app, '#cardCountLabel')
const addCardButton = requireElement<HTMLButtonElement>(app, '#addCardButton')
const layersAccordion = requireElement<HTMLDivElement>(app, '#layersAccordion')
const zoomOutButton = requireElement<HTMLButtonElement>(app, '#zoomOutButton')
const zoomInButton = requireElement<HTMLButtonElement>(app, '#zoomInButton')
const zoomFitButton = requireElement<HTMLButtonElement>(app, '#zoomFitButton')
const zoomRange = requireElement<HTMLInputElement>(app, '#zoomRange')
const zoomLabel = requireElement<HTMLSpanElement>(app, '#zoomLabel')
const themeSwitch = requireElement<HTMLInputElement>(app, '#themeSwitch')
const themeLabel = requireElement<HTMLSpanElement>(app, '#themeLabel')
const themeIcon = requireElement<HTMLSpanElement>(app, '#themeIcon')
const editorLayout = requireElement<HTMLElement>(app, '.editor-layout')
const leftPanelResizer = requireElement<HTMLDivElement>(app, '#leftPanelResizer')
const deckPanelResizer = requireElement<HTMLDivElement>(app, '#deckPanelResizer')
const rightPanelResizer = requireElement<HTMLDivElement>(app, '#rightPanelResizer')
const openTemplatesButton = requireElement<HTMLButtonElement>(app, '#openTemplatesButton')
const templatesModal = requireElement<HTMLDivElement>(app, '#templatesModal')
const templatesModalBackdrop = requireElement<HTMLDivElement>(app, '#templatesModalBackdrop')
const closeTemplatesModalButton = requireElement<HTMLButtonElement>(app, '#closeTemplatesModalButton')
const templatesGrid = requireElement<HTMLDivElement>(app, '#templatesGrid')
const editorWorkspace = requireElement<HTMLElement>(app, '#editorWorkspace')
const openTutorialButton = requireElement<HTMLButtonElement>(app, '#openTutorialButton')
const tutorialSection = requireElement<HTMLElement>(app, '#tutorialSection')
const backToEditorButton = requireElement<HTMLButtonElement>(app, '#backToEditorButton')

const PANEL_WIDTHS_STORAGE_KEY = 'deckstudio.panel-widths-v2'
const DECK_PREVIEW_HIDDEN_STORAGE_KEY = 'deckstudio.deck-preview-hidden-v1'
const DECK_PREVIEW_MIN_WIDTH = 220
const DECK_PREVIEW_MAX_WIDTH = 460
let deckPreviewHidden = localStorage.getItem(DECK_PREVIEW_HIDDEN_STORAGE_KEY) === 'true'

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

function syncBackToEditorButton(): void {
  const tutorialBounds = tutorialSection.getBoundingClientRect()
  const tutorialVisible = tutorialBounds.top < window.innerHeight * 0.72 && tutorialBounds.bottom > 0
  backToEditorButton.classList.toggle('is-visible', tutorialVisible)
  backToEditorButton.setAttribute('aria-hidden', String(!tutorialVisible))
  backToEditorButton.tabIndex = tutorialVisible ? 0 : -1
}

openTutorialButton.addEventListener('click', () => {
  tutorialSection.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' })
})

backToEditorButton.addEventListener('click', () => {
  editorWorkspace.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' })
})

window.addEventListener('scroll', syncBackToEditorButton, { passive: true })

function setPanelWidths(left: number, deck: number, right: number): void {
  editorLayout.style.setProperty('--left-panel-width', `${left}px`)
  editorLayout.style.setProperty('--deck-panel-width', `${deck}px`)
  editorLayout.style.setProperty('--right-panel-width', `${right}px`)
}

function currentPanelWidths(): { left: number; deck: number; right: number } {
  const styles = getComputedStyle(editorLayout)
  return {
    left: Number.parseFloat(styles.getPropertyValue('--left-panel-width')) || 320,
    deck: Number.parseFloat(styles.getPropertyValue('--deck-panel-width')) || 300,
    right: Number.parseFloat(styles.getPropertyValue('--right-panel-width')) || 360,
  }
}

try {
  const saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? '{}') as { left?: number; deck?: number; right?: number }
  if (Number.isFinite(saved.left) && Number.isFinite(saved.right)) {
    setPanelWidths(
      saved.left!,
      Number.isFinite(saved.deck) ? clamp(DECK_PREVIEW_MIN_WIDTH, DECK_PREVIEW_MAX_WIDTH, saved.deck!) : 300,
      saved.right!,
    )
  }
} catch {
  // Ignora preferências antigas ou inválidas.
}

function attachPanelResizer(handle: HTMLElement, side: 'left' | 'deck' | 'right'): void {
  const resizeBy = (delta: number): void => {
    const widths = currentPanelWidths()
    const available = editorLayout.clientWidth
    const showDeck = !deckPreviewHidden && activeEditMode === 'deck'
    const deckWidth = showDeck ? widths.deck : 0
    const fixedTracks = widths.left + deckWidth + widths.right + 24 + 36 + 320
    const maxLeft = Math.min(420, available - (fixedTracks - widths.left))
    const maxDeck = Math.min(DECK_PREVIEW_MAX_WIDTH, available - (fixedTracks - deckWidth))
    const maxRight = Math.min(520, available - (fixedTracks - widths.right))
    const left = side === 'left' ? clamp(180, Math.max(180, maxLeft), widths.left + delta) : widths.left
    const deck = side === 'deck'
      ? clamp(DECK_PREVIEW_MIN_WIDTH, Math.max(DECK_PREVIEW_MIN_WIDTH, maxDeck), widths.deck - delta)
      : widths.deck
    const right = side === 'right' ? clamp(280, Math.max(280, maxRight), widths.right - delta) : widths.right
    setPanelWidths(left, deck, right)
    fitCanvasZoomToStage()
  }

  handle.addEventListener('pointerdown', (event) => {
    const startX = event.clientX
    const start = currentPanelWidths()
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-panels')

    const move = (moveEvent: PointerEvent): void => {
      setPanelWidths(start.left, start.deck, start.right)
      resizeBy(moveEvent.clientX - startX)
    }
    const stop = (): void => {
      handle.removeEventListener('pointermove', move)
      document.body.classList.remove('is-resizing-panels')
      localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(currentPanelWidths()))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop, { once: true })
    handle.addEventListener('pointercancel', stop, { once: true })
  })

  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 12 : -12
    resizeBy(side === 'right' || side === 'deck' ? -direction : direction)
    localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(currentPanelWidths()))
  })
}

attachPanelResizer(leftPanelResizer, 'left')
attachPanelResizer(deckPanelResizer, 'deck')
attachPanelResizer(rightPanelResizer, 'right')

function syncDeckPreviewVisibility(): void {
  const hidden = deckPreviewHidden || activeEditMode !== 'deck'
  cardsSection.hidden = hidden
  cardsSection.classList.toggle('tab-panel-hidden', hidden)
  editorLayout.classList.toggle('is-deck-preview-hidden', hidden)
  editDeckButton.classList.toggle('is-active', !hidden)
  editDeckButton.title = hidden ? 'Mostrar coluna Baralho' : 'Ocultar coluna Baralho'
  editDeckButton.setAttribute('aria-label', editDeckButton.title)
  editDeckButton.setAttribute('aria-checked', String(!hidden))
}

function syncThemeSwitch(theme: ColorTheme): void {
  const isDark = theme === 'dark'
  themeSwitch.checked = isDark
  themeSwitch.setAttribute('aria-label', isDark ? 'Ativar modo claro' : 'Ativar modo escuro')
  themeLabel.textContent = isDark ? 'Modo escuro' : 'Modo claro'
  themeIcon.textContent = isDark ? 'dark_mode' : 'light_mode'
}

async function switchToBackView(): Promise<void> {
  if (activeEditMode === 'back') return
  persistActiveDeckDocument()
  activeEditMode = 'back'
  activeRightPanelTab = 'model-layers'
  destroySelectedTextEditor()
  const deck = currentDeck()
  const activeCard = deck.cards.find(c => c.id === deck.activeCardId)
  deck.activeBackId = backOfCard(deck, activeCard).id
  await loadDeckCanvas(activeBackOf(deck).canvas)
  renderWorkspaceTabs()
}

syncThemeSwitch(getInitialColorTheme())
themeSwitch.addEventListener('change', () => {
  const theme: ColorTheme = themeSwitch.checked ? 'dark' : 'light'
  applyColorTheme(theme)
  localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme)
  syncThemeSwitch(theme)
})

const canvas = new Canvas('cardCanvas', {
  preserveObjectStacking: true,
  selection: true,
})
const syncCanvasFrame = (): void => {
  const hasContent = canvas.getObjects().length > 0
  canvasStage.classList.toggle('is-empty', !hasContent)
  canvasStage.classList.toggle('has-content', hasContent)
}
canvas.on('object:added', syncCanvasFrame)
canvas.on('object:removed', syncCanvasFrame)
syncCanvasFrame()
const thumbnailCanvasElement = document.createElement('canvas')
thumbnailCanvasElement.width = CARD_WIDTH
thumbnailCanvasElement.height = CARD_HEIGHT
const thumbnailCanvas = new Canvas(thumbnailCanvasElement, {
  preserveObjectStacking: true,
  selection: false,
  renderOnAddRemove: false,
})

const layerById = new Map<string, FabricObject>()
let layerCount = 0
let suppressSelectionSync = false
let draggedLayerId: string | null = null
let copiedModelAttributes: {
  sourceIsText: boolean
  position: Record<string, unknown>
  shape: Record<string, unknown>
  font: Record<string, unknown> | null
  color: Record<string, unknown>
} | null = null
let canvasDisplayZoom = 1
let activeRightPanelTab: 'cards' | 'model-layers' = 'cards'
let selectedTextEditor: Editor | null = null

deckDocuments = [createDeckDocument(DEFAULT_DECK_NAME)]
activeDeckId = deckDocuments[0].id

function renderWorkspaceTabs(): void {
  const modelActive = activeEditMode === 'model'
  const backActive = activeEditMode === 'back'
  const templateActive = modelActive || backActive

  if (templateActive) {
    activeRightPanelTab = 'model-layers'
  } else if (activeRightPanelTab === 'model-layers') {
    activeRightPanelTab = 'cards'
  }

  editModelButton.classList.toggle('is-active', modelActive)
  editBackButton.classList.toggle('is-active', backActive)
  const showCards = activeEditMode === 'deck'
  const showLayers = templateActive || showCards

  layersSection.hidden = !showLayers
  layersSection.classList.toggle('tab-panel-hidden', !showLayers)
  cardsSection.classList.toggle('tab-panel-hidden', !showCards || deckPreviewHidden)
  syncDeckPreviewVisibility()
  cardVariantControls.hidden = !showCards
  variantBar.hidden = showCards
  layersSectionTitle.textContent = showCards
    ? `Layers · ${currentDeck().cards.find(card => card.id === currentDeck().activeCardId)?.name ?? 'Carta'}`
    : activeEditMode === 'back' ? 'Verso' : 'Modelo'
  libraryLauncher.classList.toggle('library-only', !templateActive)

  if (showLayers) {
    if (templateActive) renderVariantBar()
    renderLayersAccordion()
  } else {
    layersAccordion.innerHTML = ''
  }

  renderEditorPanel()

  syncModeControls()
  renderLibrary()
  if (showCards) {
    renderCardVariantControls()
    renderCardThumbnails()
  }
}

function renderEditorPanel(): void {
  if (activeEditMode === 'deck') {
    renderSelectedItemEditor()
    return
  }

  destroySelectedTextEditor()
  const selected = canvas.getActiveObject()
  if (!selected) {
    editItemLabel.textContent = 'Selecione um layer na carta ou na lista para editar.'
    renderEditEmptyMessage('Nenhum layer selecionado.')
    return
  }

  if (selected instanceof ActiveSelection) {
    editItemLabel.textContent = `${selected.getObjects().length} layers selecionados`
    editPanelContent.innerHTML = ''
    editPanelContent.append(createArrangeControls())
    return
  }

  const meta = getLayerMeta(selected)
  editItemLabel.textContent = `${meta.name} • ${layerKindLabel(meta.kind)}`
  editPanelContent.innerHTML = ''
  const body = document.createElement('div')
  body.className = 'layer-body'
  const editable = meta.scope === activeEditMode
  buildLayerBody(selected, meta, editable, body)
  if (editable) {
    body.prepend(createArrangeControls())
  }
  editPanelContent.append(body)
}

function createLayerAttributeTransferControls(object: FabricObject): HTMLElement {
  const controls = document.createElement('div')
  controls.className = 'layer-attribute-transfer'

  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.className = 'tiny primary'
  copyButton.textContent = 'Copiar atributos'
  copyButton.addEventListener('click', () => {
    const props = object.toObject(['data']) as Record<string, unknown>
    const pick = (keys: string[]): Record<string, unknown> => Object.fromEntries(
      keys.filter((key) => Object.hasOwn(props, key)).map((key) => [key, deepClone(props[key])]),
    )
    const geometry = (object: FabricObject): Record<string, unknown> => ({
      width: object.getScaledWidth(),
      height: object.getScaledHeight(),
    })
    copiedModelAttributes = {
      sourceIsText: isTextLayer(object),
      position: {
        left: object.left,
        top: object.top,
        originX: object.originX,
        originY: object.originY,
      },
      shape: {
        ...geometry(object),
        ...pick(['angle', 'skewX', 'skewY', 'flipX', 'flipY', 'rx', 'ry', 'strokeWidth', 'strokeDashArray', 'strokeLineCap', 'strokeLineJoin', 'strokeUniform']),
      },
      font: isTextLayer(object) ? {
        ...pick(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline', 'linethrough', 'overline', 'textAlign', 'lineHeight', 'charSpacing']),
        styles: Object.fromEntries(Object.entries(
          deepClone((object as FabricText | Textbox).styles) as Record<string, Record<string, Record<string, unknown>>>,
        ).map(([line, characters]) => [line, Object.fromEntries(
          Object.entries(characters).map(([character, style]) => [character, Object.fromEntries(
            Object.entries(style).filter(([key]) => [
              'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline', 'linethrough', 'overline', 'deltaY',
            ].includes(key)),
          )]).filter(([, style]) => Object.keys(style as Record<string, unknown>).length > 0),
        )]).filter(([, characters]) => Object.keys(characters as Record<string, unknown>).length > 0)),
      } : null,
      color: pick(['fill', 'stroke']),
    }
    pasteButtons.forEach((button) => { button.disabled = false })
    pasteFontButton.disabled = !isTextLayer(object)
  })

  const applyPasteGroup = (group: 'position' | 'shape' | 'font' | 'color'): void => {
    const copiedAttributes = copiedModelAttributes
    if (!copiedAttributes) return
    const values = copiedAttributes[group]
    if (!values || (group === 'font' && (!copiedAttributes.sourceIsText || !isTextLayer(object)))) return
    const properties = deepClone(values)
    if (group === 'shape') {
      const size = properties as { width: number; height: number }
      const shapeProperties = { ...properties }
      delete shapeProperties.width
      delete shapeProperties.height
      if (!(object instanceof Rect)) {
        delete shapeProperties.rx
        delete shapeProperties.ry
      }
      object.set({
        ...shapeProperties,
        scaleX: size.width / Math.max(1, object.width ?? 1),
        scaleY: size.height / Math.max(1, object.height ?? 1),
      })
    } else if (group === 'font' && isTextLayer(object)) {
      const font = properties as Record<string, unknown>
      const { styles, ...fontProperties } = font
      object.set(fontProperties)
      const currentStyles = deepClone((object as FabricText | Textbox).styles) as Record<string, Record<string, Record<string, unknown>>>
      Object.entries(styles as Record<string, Record<string, Record<string, unknown>>>).forEach(([line, characters]) => {
        currentStyles[line] ??= {}
        Object.entries(characters).forEach(([character, style]) => {
          currentStyles[line][character] = { ...(currentStyles[line][character] ?? {}), ...style }
        })
      })
      ;(object as FabricText | Textbox).set('styles', currentStyles)
    } else {
      object.set(properties)
    }
  }

  const finishPaste = (): void => {
    object.set('dirty', true)
    object.setCoords()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
    renderLayersAccordion()
  }

  const paste = (group: 'position' | 'shape' | 'font' | 'color'): void => {
    applyPasteGroup(group)
    finishPaste()
  }

  const makePasteButton = (label: string, group: 'position' | 'shape' | 'font' | 'color'): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tiny ghost'
    button.textContent = label
    button.disabled = !copiedModelAttributes || (group === 'font' && (!copiedModelAttributes.sourceIsText || !isTextLayer(object)))
    button.addEventListener('click', () => paste(group))
    return button
  }

  const pastePositionButton = makePasteButton('Colar somente posição', 'position')
  const pasteShapeButton = makePasteButton('Colar somente forma', 'shape')
  const pasteFontButton = makePasteButton('Colar somente fonte', 'font')
  const pasteColorButton = makePasteButton('Colar somente cor', 'color')
  const pasteAllButton = document.createElement('button')
  pasteAllButton.type = 'button'
  pasteAllButton.className = 'tiny primary'
  pasteAllButton.textContent = 'Colar tudo'
  pasteAllButton.disabled = !copiedModelAttributes
  pasteAllButton.addEventListener('click', () => {
    if (!copiedModelAttributes) return
    applyPasteGroup('position')
    applyPasteGroup('shape')
    applyPasteGroup('font')
    applyPasteGroup('color')
    finishPaste()
  })
  const pasteButtons = [pastePositionButton, pasteShapeButton, pasteFontButton, pasteColorButton, pasteAllButton]

  const actions = document.createElement('div')
  actions.className = 'layer-attribute-actions'
  actions.append(copyButton, ...pasteButtons)
  controls.append(actions)
  return controls
}

function createArrangeControls(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'arrange-controls'

  const targets = (): FabricObject[] => canvas.getActiveObjects().filter((object) => {
    const meta = getLayerMeta(object)
    return meta.scope === activeEditMode && !meta.locked && !meta.isBackground
  })

  // Opera em coordenadas absolutas: desfaz a seleção múltipla, aplica e restaura.
  const apply = (change: (objects: FabricObject[]) => void): void => {
    const objects = targets()
    if (objects.length === 0) return
    const wasMulti = canvas.getActiveObject() instanceof ActiveSelection
    canvas.discardActiveObject()
    change(objects)
    objects.forEach((object) => object.setCoords())
    if (wasMulti && objects.length > 1) {
      canvas.setActiveObject(new ActiveSelection(objects, { canvas }))
    } else {
      canvas.setActiveObject(objects[0])
    }
    canvas.requestRenderAll()
    persistActiveDeckDocument()
    renderLayersAccordion()
  }

  const shift = (object: FabricObject, dx: number, dy: number): void => {
    object.set({ left: (object.left ?? 0) + dx, top: (object.top ?? 0) + dy })
  }

  const bounds = (objects: FabricObject[]): { left: number; top: number; right: number; bottom: number } => {
    if (objects.length === 1) return { left: 0, top: 0, right: CARD_WIDTH, bottom: CARD_HEIGHT }
    const rects = objects.map((object) => object.getBoundingRect())
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.left + r.width)),
      bottom: Math.max(...rects.map((r) => r.top + r.height)),
    }
  }

  type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
  const align = (mode: AlignMode): void => apply((objects) => {
    const box = bounds(objects)
    objects.forEach((object) => {
      const r = object.getBoundingRect()
      if (mode === 'left') shift(object, box.left - r.left, 0)
      else if (mode === 'right') shift(object, box.right - (r.left + r.width), 0)
      else if (mode === 'centerX') shift(object, (box.left + box.right) / 2 - (r.left + r.width / 2), 0)
      else if (mode === 'top') shift(object, 0, box.top - r.top)
      else if (mode === 'bottom') shift(object, 0, box.bottom - (r.top + r.height))
      else shift(object, 0, (box.top + box.bottom) / 2 - (r.top + r.height / 2))
    })
  })

  const distribute = (axis: 'x' | 'y'): void => apply((objects) => {
    if (objects.length < 3) return
    const items = objects
      .map((object) => ({ object, r: object.getBoundingRect() }))
      .sort((a, b) => (axis === 'x' ? a.r.left - b.r.left : a.r.top - b.r.top))
    const size = (r: { width: number; height: number }): number => (axis === 'x' ? r.width : r.height)
    const start = axis === 'x' ? items[0].r.left : items[0].r.top
    const last = items[items.length - 1].r
    const end = axis === 'x' ? last.left + last.width : last.top + last.height
    const gap = (end - start - items.reduce((sum, item) => sum + size(item.r), 0)) / (items.length - 1)
    let cursor = start
    items.forEach(({ object, r }) => {
      const current = axis === 'x' ? r.left : r.top
      if (axis === 'x') shift(object, cursor - current, 0)
      else shift(object, 0, cursor - current)
      cursor += size(r) + gap
    })
  })

  const fill = (horizontal: boolean, vertical: boolean): void => apply((objects) => {
    objects.forEach((object) => {
      if (object instanceof Textbox && getLayerMeta(object).kind === 'text' && (object.angle ?? 0) === 0) {
        // Texto: redimensiona a caixa em vez de deformar as letras.
        const sx = object.scaleX || 1
        const sy = object.scaleY || 1
        if (horizontal) object.set({ width: CARD_WIDTH / sx })
        if (vertical) setLayerMeta(object, { ...getLayerMeta(object), textBoxHeight: CARD_HEIGHT / sy })
        object.initDimensions()
        object.setCoords()
        const box = object.getBoundingRect()
        shift(
          object,
          horizontal ? CARD_WIDTH / 2 - (box.left + box.width / 2) : 0,
          vertical ? CARD_HEIGHT / 2 - (box.top + box.height / 2) : 0,
        )
        return
      }
      const r = object.getBoundingRect()
      if (horizontal && r.width >= 1) {
        object.set({ scaleX: (object.scaleX ?? 1) * (CARD_WIDTH / r.width) })
      }
      if (vertical && r.height >= 1) {
        object.set({ scaleY: (object.scaleY ?? 1) * (CARD_HEIGHT / r.height) })
      }
      object.setCoords()
      const next = object.getBoundingRect()
      shift(
        object,
        horizontal ? CARD_WIDTH / 2 - (next.left + next.width / 2) : 0,
        vertical ? CARD_HEIGHT / 2 - (next.top + next.height / 2) : 0,
      )
    })
  })

  const group = (title: string, items: Array<[string, string, () => void]>): void => {
    const row = document.createElement('div')
    row.className = 'arrange-row'
    const label = document.createElement('span')
    label.className = 'arrange-label'
    label.textContent = title
    row.append(label)
    items.forEach(([text, tip, handler]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tiny ghost'
      button.textContent = text
      button.title = tip
      button.setAttribute('aria-label', tip)
      button.addEventListener('click', handler)
      row.append(button)
    })
    wrap.append(row)
  }

  group('Preencher', [
    ['↔ Largura', 'Preencher toda a largura da carta', () => fill(true, false)],
    ['↕ Altura', 'Preencher toda a altura da carta', () => fill(false, true)],
    ['⤢ Tudo', 'Preencher largura e altura da carta', () => fill(true, true)],
  ])
  group('Alinhar', [
    ['⇤', 'Alinhar à esquerda', () => align('left')],
    ['⇹', 'Centralizar na horizontal', () => align('centerX')],
    ['⇥', 'Alinhar à direita', () => align('right')],
    ['⤒', 'Alinhar ao topo', () => align('top')],
    ['⇕', 'Centralizar na vertical', () => align('centerY')],
    ['⤓', 'Alinhar à base', () => align('bottom')],
  ])
  if (canvas.getActiveObject() instanceof ActiveSelection) {
    group('Distribuir', [
      ['↔', 'Distribuir horizontalmente (3+ itens)', () => distribute('x')],
      ['↕', 'Distribuir verticalmente (3+ itens)', () => distribute('y')],
    ])
  }
  const hint = document.createElement('p')
  hint.className = 'layer-note'
  hint.textContent = canvas.getActiveObject() instanceof ActiveSelection
    ? 'Alinha entre os itens selecionados.'
    : 'Alinha em relação à carta. Selecione vários itens (arraste na carta) para alinhar entre si.'
  wrap.append(hint)
  return wrap
}

function syncModeControls(): void {
  addGraphicButton.disabled = false
  addTextButton.disabled = false
  shapePalette.querySelectorAll('button').forEach((button) => { button.disabled = false })
}

function destroySelectedTextEditor(): void {
  if (!selectedTextEditor) {
    return
  }

  selectedTextEditor.destroy()
  selectedTextEditor = null
}

function selectedDeckEditableObject(): FabricObject | null {
  if (activeEditMode !== 'deck') {
    return null
  }

  const object = canvas.getActiveObject()
  if (!object) {
    return null
  }

  const meta = getLayerMeta(object)
  return meta.scope === 'deck' ? object : null
}

function renderEditEmptyMessage(message: string): void {
  destroySelectedTextEditor()
  editPanelContent.innerHTML = ''
  const empty = document.createElement('p')
  empty.className = 'layer-note'
  empty.textContent = message
  editPanelContent.append(empty)
}

function commitDeckContentChanges(): void {
  canvas.requestRenderAll()
  persistActiveDeckDocument()
  renderCardThumbnails()
}

function createEditorToolbarButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tiny ghost'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function textObjectToEditorHtml(textObject: FabricText | Textbox): string {
  const meta = getLayerMeta(textObject)
  if (meta.richTextFormat === 'html' && meta.richTextSource) return meta.richTextSource

  const styles = (textObject as unknown as { styles?: Record<number, Record<number, Record<string, unknown>>> }).styles ?? {}
  const text = String((textObject as { text?: unknown }).text ?? '')
  const escape = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const lines = text.split('\n').map((line, lineIndex) => Array.from(line).map((character, charIndex) => {
    const style = styles[lineIndex]?.[charIndex] ?? {}
    const css = [
      typeof style['fill'] === 'string' ? `color:${style['fill']}` : '',
      typeof style['fontFamily'] === 'string' ? `font-family:${style['fontFamily']}` : '',
      typeof style['fontSize'] === 'number' ? `font-size:${style['fontSize']}px` : '',
      typeof style['fontWeight'] === 'string' ? `font-weight:${style['fontWeight']}` : '',
      typeof style['fontStyle'] === 'string' ? `font-style:${style['fontStyle']}` : '',
      typeof style['textBackgroundColor'] === 'string' ? `background-color:${style['textBackgroundColor']}` : '',
      typeof style['textBackgroundRadius'] === 'number' ? `border-radius:${style['textBackgroundRadius']}px` : '',
      typeof style['textBackgroundPaddingX'] === 'number' || typeof style['textBackgroundPaddingY'] === 'number'
        ? `padding:${Number(style['textBackgroundPaddingY']) || 0}px ${Number(style['textBackgroundPaddingX']) || 0}px`
        : '',
      style['underline'] ? 'text-decoration:underline' : '',
    ].filter(Boolean).join(';')
    const content = escape(character)
    return css ? `<span style="${escape(css)}">${content}</span>` : content
  }).join('')).join('<br>')
  return lines || '<p></p>'
}

function renderRichTextEditor(
  container: HTMLElement,
  textObject: FabricText | Textbox,
  commit: () => void,
): void {
  const title = document.createElement('p')
  title.className = 'layer-note'
  title.textContent = 'Editor de texto'
  container.append(title)

  const toolbar = document.createElement('div')
  toolbar.className = 'rich-toolbar'

  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.value = '#2f9e44'
  attachNoDragPropagation(colorInput)

  const applyColorButton = createEditorToolbarButton('Cor', () => {
    selectedTextEditor?.chain().focus().setColor(colorInput.value).run()
  })
  const clearColorButton = createEditorToolbarButton('Limpar cor', () => {
    selectedTextEditor?.chain().focus().unsetColor().run()
  })
  const boldButton = createEditorToolbarButton('Negrito', () => {
    selectedTextEditor?.chain().focus().toggleBold().run()
  })
  const italicButton = createEditorToolbarButton('Itálico', () => {
    selectedTextEditor?.chain().focus().toggleItalic().run()
  })
  const underlineButton = createEditorToolbarButton('Sublinhado', () => {
    selectedTextEditor?.chain().focus().toggleUnderline().run()
  })
  const clearMarksButton = createEditorToolbarButton('Limpar estilo', () => {
    selectedTextEditor?.chain().focus().unsetAllMarks().run()
  })

  toolbar.append(
    boldButton,
    italicButton,
    underlineButton,
    colorInput,
    applyColorButton,
    clearColorButton,
    clearMarksButton,
  )
  container.append(toolbar)
  container.append(detailsRow('Meus 5 estilos', createSavedTextColorPalette((style) => {
    selectedTextEditor?.chain().focus().setMark('textStyle', {
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderRadius: `${style.borderRadius}px`,
      textPadding: `${style.paddingY}px ${style.paddingX}px`,
      presetFontSize: `${style.fontSize}px`,
    }).run()
  })))

  const editorElement = document.createElement('div')
  editorElement.className = 'rich-editor-surface'
  container.append(editorElement)

  destroySelectedTextEditor()

  selectedTextEditor = new Editor({
    element: editorElement,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        orderedList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        underline: false,
      }),
      StyledTextStyle,
      Color,
      Underline,
    ],
    content: textObjectToEditorHtml(textObject),
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      applyRichTextToObject(textObject, html, 'html')
      textObject.setCoords()
      container.dispatchEvent(new CustomEvent('rich-text-sync'))
      commit()
    },
  })

  const baseFontFamily = String((textObject as { fontFamily?: unknown }).fontFamily ?? 'Arial')
  editorElement.style.fontFamily = baseFontFamily
  const toggles: Array<[HTMLButtonElement, string]> = [[boldButton, 'bold'], [italicButton, 'italic'], [underlineButton, 'underline']]
  const syncToggles = (): void => {
    const editor = selectedTextEditor
    if (editor) toggles.forEach(([button, name]) => button.classList.toggle('is-active', editor.isActive(name)))
  }
  // Blur dispara transaction; por isso a cor só sincroniza quando a seleção muda.
  const syncToolbar = (): void => {
    const editor = selectedTextEditor
    if (!editor) return
    syncToggles()
    const attrs = editor.getAttributes('textStyle') as Record<string, string | null>
    const color = attrs['color']
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) colorInput.value = color
  }
  selectedTextEditor.on('selectionUpdate', syncToolbar)
  selectedTextEditor.on('transaction', syncToggles)
  syncToolbar()
}

function removeLegacyTaggedTextControls(container: HTMLElement): void {
  container.querySelectorAll('textarea').forEach((field) => field.closest('.layer-detail-row')?.remove())
  container.querySelectorAll('.text-color-palette, .inline-color-controls').forEach((control) => {
    control.closest('.layer-detail-row')?.remove()
  })

  const legacyLabels = new Set([
    'Formato da tag de cor',
    'Paleta rápida',
    'Tag com cor personalizada',
    'Aplicar cor custom',
    'Cores rápidas',
    'Cor personalizada',
  ])
  container.querySelectorAll<HTMLDivElement>('.layer-detail-row').forEach((row) => {
    const label = row.querySelector('label')
    const labelText = Array.from(label?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? '')
      .join(' ')
      .trim()
    if (legacyLabels.has(labelText)) row.remove()
  })

  const savedStyleRows = Array.from(container.querySelectorAll<HTMLDivElement>('.layer-detail-row'))
    .filter((row) => row.querySelector('.saved-color-palette'))
  savedStyleRows.slice(1).forEach((row) => row.remove())
}

function renderSelectedTextEditor(textObject: FabricText | Textbox): void {
  renderRichTextEditor(editPanelContent, textObject, commitDeckContentChanges)

  const fontFamilyField = createFontSelect(String((textObject as { fontFamily?: unknown }).fontFamily ?? 'Arial'))
  attachNoDragPropagation(fontFamilyField)
  fontFamilyField.addEventListener('change', () => {
    textObject.set({ fontFamily: fontFamilyField.value })
    commitDeckContentChanges()
  })
  editPanelContent.append(detailsRow('Fonte base', fontFamilyField))

  const fontSizeField = document.createElement('input')
  fontSizeField.type = 'number'
  fontSizeField.min = '8'
  fontSizeField.max = '220'
  fontSizeField.step = '1'
  fontSizeField.value = String((textObject as { fontSize?: unknown }).fontSize ?? 40)
  attachNoDragPropagation(fontSizeField)
  fontSizeField.addEventListener('input', () => {
    textObject.set({ fontSize: clamp(8, 220, Number(fontSizeField.value) || 40) })
    commitDeckContentChanges()
  })
  editPanelContent.append(detailsRow('Tamanho base', fontSizeField))
  editPanelContent.append(createTextLayoutControls(textObject, commitDeckContentChanges))
  editPanelContent.append(createArrangeControls())
}

function createGraphicSizeControls(graphic: FabricObject): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const meta = getLayerMeta(graphic)
  const pair = document.createElement('div')
  pair.className = 'layer-detail-pair'
  fragment.append(pair)
  const field = (label: string, current: number, apply: (value: number) => void): void => {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.max = '4000'
    input.value = String(Math.round(current))
    attachNoDragPropagation(input)
    input.addEventListener('input', () => {
      const value = Number(input.value)
      if (value < 1) return
      apply(value)
      graphic.setCoords()
      canvas.requestRenderAll()
      persistActiveDeckDocument()
    })
    pair.append(detailsRow(label, input))
  }
  const naturalWidth = Math.max(1, graphic.width ?? 1)
  const naturalHeight = Math.max(1, graphic.height ?? 1)
  field('Largura', naturalWidth * (graphic.scaleX ?? 1), (v) => graphic.set({ scaleX: v / naturalWidth }))
  field('Altura', naturalHeight * (graphic.scaleY ?? 1), (v) => graphic.set({ scaleY: v / naturalHeight }))
  fragment.querySelectorAll('input').forEach((input) => { input.disabled = Boolean(meta.locked || meta.isBackground) })
  return fragment
}

function createGraphicPositionControls(graphic: FabricObject): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const meta = getLayerMeta(graphic)
  const center = graphic.getCenterPoint()
  const pair = document.createElement('div')
  pair.className = 'layer-detail-pair'
  fragment.append(pair)
  const field = (label: string, current: number, apply: (point: Point, value: number) => void): void => {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '-4000'
    input.max = '4000'
    input.value = String(Math.round(current))
    input.disabled = Boolean(meta.locked || meta.isBackground)
    attachNoDragPropagation(input)
    input.addEventListener('input', () => {
      if (input.value === '' || !Number.isFinite(Number(input.value))) return
      const point = graphic.getCenterPoint()
      apply(point, Number(input.value))
      graphic.setPositionByOrigin(point, 'center', 'center')
      graphic.setCoords()
      canvas.requestRenderAll()
      persistActiveDeckDocument()
    })
    pair.append(detailsRow(label, input))
  }
  field('Posição X', center.x, (point, value) => { point.x = value })
  field('Posição Y', center.y, (point, value) => { point.y = value })
  return fragment
}

async function duplicateGraphic(graphic: FabricObject, offset: number): Promise<FabricObject | null> {
  const meta = getLayerMeta(graphic)
  if (meta.kind !== 'graphic' || meta.scope !== activeEditMode || meta.locked || meta.isBackground) return null
  const copy = await graphic.clone()
  setLayerMeta(copy, { ...deepClone(meta), id: generateLayerId() })
  copy.set({ left: (graphic.left ?? 0) + offset, top: (graphic.top ?? 0) + offset })
  applyRuntimeConfig(copy)
  return copy
}

async function duplicateSelectedGraphic(): Promise<void> {
  const active = canvas.getActiveObject()
  if (!active || active instanceof ActiveSelection) return
  const copy = await duplicateGraphic(active, 20)
  if (!copy) return
  addPastedGraphic(copy)
}

let copiedGraphic: FabricObject | null = null

async function copySelectedGraphic(): Promise<boolean> {
  const active = canvas.getActiveObject()
  if (!active || active instanceof ActiveSelection) return false
  const copy = await duplicateGraphic(active, 0)
  if (!copy) return false
  copiedGraphic = copy
  return true
}

async function pasteCopiedGraphic(): Promise<void> {
  if (!copiedGraphic) return
  const copy = await copiedGraphic.clone()
  setLayerMeta(copy, { ...deepClone(getLayerMeta(copiedGraphic)), id: generateLayerId(), scope: activeEditMode })
  applyRuntimeConfig(copy)
  addPastedGraphic(copy)
}

function addPastedGraphic(copy: FabricObject): void {
  canvas.add(copy)
  canvas.setActiveObject(copy)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
  if (activeEditMode === 'deck') renderWorkspaceTabs()
}

function createGraphicScaleControls(graphic: FabricObject): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (!(graphic instanceof FabricImage)) return fragment

  const meta = getLayerMeta(graphic)
  const libraryAsset = currentDeck().library.find((asset) => asset.name === meta.name)
  const graphicSource = meta.graphicSource ?? libraryAsset?.src ?? graphic.getSrc()
  const insets: Array<{ label: string; key: 'insetTop' | 'insetRight' | 'insetBottom' | 'insetLeft' }> = [
    { label: 'Topo', key: 'insetTop' },
    { label: 'Direita', key: 'insetRight' },
    { label: 'Base', key: 'insetBottom' },
    { label: 'Esquerda', key: 'insetLeft' },
  ]

  const insetFields = document.createElement('div')
  insetFields.className = 'graphic-insets'
  insetFields.hidden = meta.scaleMode !== 'nine-slice'

  const applyMode = async (): Promise<void> => {
    const targetWidth = Math.max(1, Math.round((graphic.width ?? 1) * (graphic.scaleX ?? 1)))
    const targetHeight = Math.max(1, Math.round((graphic.height ?? 1) * (graphic.scaleY ?? 1)))
    const mode = modeField.value === 'nine-slice' ? 'nine-slice' : 'stretch'
    const nextMeta: LayerMeta = {
      ...meta,
      graphicSource,
      scaleMode: mode,
    }
    const sourceImage = await FabricImage.fromURL(graphicSource)
    const nextSrc = mode === 'nine-slice'
      ? await createNineSliceDataUrl(sourceImage, {
        id: nextMeta.id,
        name: nextMeta.name,
        src: graphicSource,
        width: targetWidth,
        height: targetHeight,
        scaleMode: mode,
        insetTop: nextMeta.insetTop,
        insetRight: nextMeta.insetRight,
        insetBottom: nextMeta.insetBottom,
        insetLeft: nextMeta.insetLeft,
      })
      : graphicSource

    await graphic.setSrc(nextSrc)
    graphic.set({
      scaleX: targetWidth / Math.max(1, graphic.width ?? targetWidth),
      scaleY: targetHeight / Math.max(1, graphic.height ?? targetHeight),
    })
    setLayerMeta(graphic, nextMeta)
    graphic.setCoords()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
  }

  const modeField = document.createElement('select')
  modeField.innerHTML = '<option value="stretch">Normal</option><option value="nine-slice">9 partes</option>'
  modeField.value = meta.scaleMode ?? 'stretch'
  attachNoDragPropagation(modeField)
  modeField.addEventListener('change', () => {
    insetFields.hidden = modeField.value !== 'nine-slice'
    void withLoading(applyMode)
  })
  fragment.append(detailsRow('Modo de escala', modeField))

  insets.forEach(({ label, key }) => {
    const wrapper = document.createElement('label')
    wrapper.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '0'
    input.max = '4000'
    input.step = '1'
    input.value = String(meta[key] ?? 0)
    attachNoDragPropagation(input)
    input.addEventListener('change', () => {
      meta[key] = Math.max(0, Math.round(Number(input.value) || 0))
      input.value = String(meta[key])
      if (modeField.value === 'nine-slice') void withLoading(applyMode)
      else {
        setLayerMeta(graphic, { ...meta, graphicSource, scaleMode: 'stretch' })
        persistActiveDeckDocument()
      }
    })
    wrapper.append(input)
    insetFields.append(wrapper)
  })
  fragment.append(insetFields)

  if (!meta.graphicSource) {
    setLayerMeta(graphic, { ...meta, graphicSource })
  }
  return fragment
}

async function replaceGraphicSource(graphic: FabricImage, source: string, name?: string): Promise<void> {
  const meta = getLayerMeta(graphic)
  const targetWidth = Math.max(1, Math.round((graphic.width ?? 1) * (graphic.scaleX ?? 1)))
  const targetHeight = Math.max(1, Math.round((graphic.height ?? 1) * (graphic.scaleY ?? 1)))
  let nextSrc = source
  if (meta.scaleMode === 'nine-slice') {
    nextSrc = await createNineSliceDataUrl(await FabricImage.fromURL(source), {
      id: meta.id,
      name: meta.name,
      src: source,
      width: targetWidth,
      height: targetHeight,
      scaleMode: 'nine-slice',
      insetTop: meta.insetTop,
      insetRight: meta.insetRight,
      insetBottom: meta.insetBottom,
      insetLeft: meta.insetLeft,
    })
  }
  await graphic.setSrc(nextSrc)
  graphic.set({
    scaleX: targetWidth / Math.max(1, graphic.width ?? targetWidth),
    scaleY: targetHeight / Math.max(1, graphic.height ?? targetHeight),
  })
  setLayerMeta(graphic, { ...meta, graphicSource: source, ...(name ? { name } : {}) })
  graphic.setCoords()
  refreshLayerIndex()
  renderLayersAccordion()
  canvas.requestRenderAll()
  persistActiveDeckDocument()
}

function createGraphicReplaceControls(graphic: FabricObject): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (!(graphic instanceof FabricImage)) return fragment
  const meta = getLayerMeta(graphic)
  if (meta.locked || meta.isBackground) return fragment

  const run = (source: string, name?: string): void => {
    void withLoading(async () => {
      try {
        await replaceGraphicSource(graphic, source, name)
      } catch {
        window.alert('Falha ao substituir o asset.')
      }
    }).then(() => { if (canvas.getActiveObject() === graphic) renderSelectedItemEditor() })
  }

  const assetButton = document.createElement('button')
  assetButton.type = 'button'
  assetButton.className = 'ghost tiny'
  assetButton.textContent = 'Trocar por asset…'
  attachNoDragPropagation(assetButton)
  assetButton.addEventListener('click', () => { void chooseAssetForGraphic(graphic) })

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*'
  fileInput.hidden = true
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (file) run(await fileToObjectUrl(file), file.name.replace(/\.[^.]+$/, '') || meta.name)
  })
  const fileButton = document.createElement('button')
  fileButton.type = 'button'
  fileButton.className = 'ghost tiny'
  fileButton.textContent = 'Trocar por arquivo…'
  attachNoDragPropagation(fileButton)
  fileButton.addEventListener('click', () => fileInput.click())

  fragment.append(assetButton, fileButton, fileInput)
  return fragment
}

async function chooseAssetForGraphic(graphic: FabricImage): Promise<void> {
  const asset = await pickLibraryAsset()
  if (!asset) return
  await withLoading(async () => {
    try {
      await replaceGraphicSource(graphic, asset.src, asset.name)
    } catch {
      window.alert('Falha ao substituir o asset.')
    }
  })
  if (canvas.getActiveObject() === graphic) renderSelectedItemEditor()
}

async function chooseAssetForIllustration(object: FabricImage): Promise<void> {
  const asset = await pickLibraryAsset()
  if (!asset) return
  try {
    const fit = normalizeImageFit(getLayerMeta(object).fit ?? 'contain', 'contain')
    await replaceIllustrationOnObject(object, asset.src, fit)
    canvas.requestRenderAll()
    persistActiveDeckDocument()
    renderCardThumbnails()
  } catch {
    window.alert('Falha ao substituir a ilustracao desta carta.')
  }
}

function renderSelectedGraphicEditor(graphic: FabricObject): void {
  const commit = (): void => {
    graphic.setCoords()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
  }
  const note = document.createElement('p')
  note.className = 'layer-note'
  note.textContent = 'Gráfico da biblioteca aplicado apenas nesta carta. Arraste na carta para mover.'
  editPanelContent.append(note)

  const range = (min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(value)
    attachNoDragPropagation(input)
    input.addEventListener('input', () => onInput(Number(input.value)))
    return input
  }

  editPanelContent.append(
    createGraphicReplaceControls(graphic),
    createGraphicPositionControls(graphic),
    createGraphicSizeControls(graphic),
    createGraphicScaleControls(graphic),
    detailsRow('Opacidade', range(0, 1, 0.01, graphic.opacity ?? 1, (v) => { graphic.set({ opacity: v }); commit() })),
    detailsRow('Escala', range(0.05, 4, 0.01, graphic.scaleX ?? 1, (v) => { graphic.set({ scaleX: v, scaleY: v }); commit() })),
    detailsRow('Rotação', range(-180, 180, 1, graphic.angle ?? 0, (v) => { graphic.set({ angle: v }); commit() })),
  )

  const removeButton = document.createElement('button')
  removeButton.type = 'button'
  removeButton.className = 'danger'
  removeButton.textContent = 'Remover da carta'
  removeButton.addEventListener('click', () => {
    canvas.remove(graphic)
    canvas.discardActiveObject()
    refreshLayerIndex()
    persistActiveDeckDocument()
    renderWorkspaceTabs()
    canvas.requestRenderAll()
  })
  editPanelContent.append(removeButton)
}

function renderSelectedImageEditor(imageObject: FabricImage): void {
  const note = document.createElement('p')
  note.className = 'layer-note'
  note.textContent = 'Troque a ilustração apenas desta carta.'
  editPanelContent.append(note)
  editPanelContent.append(createImageBehaviorControls(imageObject))
  const meta = getLayerMeta(imageObject)
  if (!meta.locked && !meta.isBackground) {
    const assetButton = document.createElement('button')
    assetButton.type = 'button'
    assetButton.className = 'ghost tiny'
    assetButton.textContent = 'Trocar por asset…'
    attachNoDragPropagation(assetButton)
    assetButton.addEventListener('click', () => { void chooseAssetForIllustration(imageObject) })
    editPanelContent.append(assetButton)
  }
}

function renderSelectedItemEditor(): void {
  editPanelContent.innerHTML = ''
  const selected = selectedDeckEditableObject()
  if (!selected) {
    editItemLabel.textContent = 'Selecione um item da carta para editar.'
    renderEditEmptyMessage('Nenhum item editável selecionado nesta carta.')
    return
  }

  const meta = getLayerMeta(selected)
  editItemLabel.textContent = `${meta.name} • ${layerKindLabel(meta.kind)}`
  editPanelContent.append(createLayerAttributeTransferControls(selected))

  if (meta.kind === 'graphic') {
    destroySelectedTextEditor()
    renderSelectedGraphicEditor(selected)
    return
  }

  if (meta.kind === 'text' && isTextLayer(selected)) {
    renderSelectedTextEditor(selected)
    return
  }

  if (meta.kind === 'image' && selected instanceof FabricImage) {
    destroySelectedTextEditor()
    renderSelectedImageEditor(selected)
    return
  }

  destroySelectedTextEditor()
  const body = document.createElement('div')
  body.className = 'layer-body'
  buildLayerBody(selected, meta, true, body)
  body.prepend(createArrangeControls())
  editPanelContent.append(body)
}

function renderCardThumbnails(): void {
  const deck = currentDeck()
  const previousScrollTop = cardThumbnails.scrollTop
  cardThumbnails.innerHTML = ''
  cardCountLabel.textContent = `${deck.cards.length} carta${deck.cards.length === 1 ? '' : 's'}`
  renderCardVariantControls()

  deck.cards.forEach((card, index) => {
    const item = document.createElement('article')
    item.className = 'card-thumb'
    const back = backOfCard(deck, card)

    const pair = document.createElement('div')
    pair.className = 'card-thumb-pair'

    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = `card-thumb-select ${card.id === deck.activeCardId ? 'is-active' : ''}`
    selectBtn.addEventListener('mousedown', (event) => {
      // Prevent browser from scrolling overflow containers to keep focused button in view.
      event.preventDefault()
    })

    if (card.thumbnail) {
      const img = document.createElement('img')
      img.src = card.thumbnail
      img.alt = card.name
      img.className = 'card-thumb-img'
      selectBtn.append(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'card-thumb-placeholder'
      ph.textContent = String(index + 1)
      selectBtn.append(ph)
    }

    const lbl = document.createElement('span')
    lbl.className = 'card-thumb-label'
    lbl.textContent = card.name
    selectBtn.append(lbl)

    selectBtn.addEventListener('click', () => { selectCard(card.id) })

    const backBtn = document.createElement('button')
    backBtn.type = 'button'
    backBtn.className = 'card-thumb-back'
    backBtn.title = `Verso: ${back.name} (clique para alterar)`
    if (back.thumbnail) {
      const backImg = document.createElement('img')
      backImg.src = back.thumbnail
      backImg.alt = `Verso ${back.name}`
      backBtn.append(backImg)
    } else {
      backBtn.textContent = 'Verso'
    }
    backBtn.addEventListener('click', () => {
      selectCard(card.id)
      cardBackSelect.focus()
    })
    pair.append(selectBtn, backBtn)

    const meta = document.createElement('span')
    meta.className = 'card-thumb-meta'
    meta.textContent = `${modelOfCard(deck, card).name} · ${back.name}`

    const actions = document.createElement('div')
    actions.className = 'card-thumb-actions'

    const duplicateBtn = document.createElement('button')
    duplicateBtn.type = 'button'
    duplicateBtn.className = 'tiny ghost card-thumb-duplicate'
    duplicateBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">content_copy</span>'
    duplicateBtn.setAttribute('aria-label', `Duplicar ${card.name}`)
    duplicateBtn.title = `Duplicar ${card.name}`
    duplicateBtn.dataset.tooltip = `Duplicar ${card.name}`
    duplicateBtn.addEventListener('click', () => {
      duplicateCard(card.id)
    })

    const renameBtn = document.createElement('button')
    renameBtn.type = 'button'
    renameBtn.className = 'tiny ghost card-thumb-rename'
    renameBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">edit</span>'
    renameBtn.setAttribute('aria-label', `Renomear ${card.name}`)
    renameBtn.title = `Renomear ${card.name}`
    renameBtn.dataset.tooltip = `Renomear ${card.name}`
    renameBtn.addEventListener('click', () => {
      beginCardRename(card.id, item, meta)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'tiny danger card-thumb-delete'
    deleteBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>'
    deleteBtn.setAttribute('aria-label', `Excluir ${card.name}`)
    deleteBtn.title = deck.cards.length <= 1 ? 'O baralho precisa ter ao menos 1 carta.' : `Excluir ${card.name}`
    deleteBtn.dataset.tooltip = deleteBtn.title
    deleteBtn.disabled = deck.cards.length <= 1
    deleteBtn.addEventListener('click', () => {
      deleteCard(card.id)
    })

    const moveWrap = document.createElement('div')
    moveWrap.className = 'card-thumb-move'
    const makeMoveBtn = (direction: -1 | 1): HTMLButtonElement => {
      const button = document.createElement('button')
      const label = direction < 0 ? `Subir ${card.name}` : `Descer ${card.name}`
      const target = index + direction
      button.type = 'button'
      button.className = 'tiny ghost'
      button.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${direction < 0 ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</span>`
      button.setAttribute('aria-label', label)
      button.title = label
      button.dataset.tooltip = label
      button.disabled = target < 0 || target >= deck.cards.length
      button.addEventListener('click', () => { moveCard(card.id, direction) })
      return button
    }
    moveWrap.append(makeMoveBtn(-1), makeMoveBtn(1))

    actions.append(renameBtn, duplicateBtn, deleteBtn, moveWrap)
    item.append(pair, meta, actions)
    cardThumbnails.append(item)
  })

  cardThumbnails.scrollTop = previousScrollTop
}

function splitCardName(name: string): { base: string; number: number } {
  const trimmed = name.trim()
  const match = /^(.*?)(?:\s+(\d+))?$/.exec(trimmed)
  const base = match?.[1]?.trim() || 'Carta'
  const number = Math.max(1, Number(match?.[2] ?? 1) || 1)
  return { base, number }
}

function normalizeCardName(name: string): string {
  const { base, number } = splitCardName(name)
  return `${base} ${number}`
}

function nextCardName(deck: DeckDocument, nameBase: string, excludingCardId?: string): string {
  const normalizedBase = nameBase.trim().toLocaleLowerCase()
  const usedNumbers = deck.cards
    .filter(card => card.id !== excludingCardId)
    .map(card => splitCardName(card.name))
    .filter(parts => parts.base.toLocaleLowerCase() === normalizedBase)
    .map(parts => parts.number)
  return `${nameBase.trim() || 'Carta'} ${Math.max(0, ...usedNumbers) + 1}`
}

function beginCardRename(cardId: string, item: HTMLElement, meta: HTMLElement): void {
  const card = currentDeck().cards.find(candidate => candidate.id === cardId)
  if (!card) return

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'card-thumb-rename-input'
  nameInput.value = card.name
  nameInput.maxLength = 80
  nameInput.setAttribute('aria-label', `Nome da carta ${card.name}`)
  nameInput.addEventListener('click', event => event.stopPropagation())

  let finished = false
  const finish = (cancel = false): void => {
    if (finished) return
    finished = true
    if (!cancel) renameCard(cardId, nameInput.value)
    else nameInput.remove()
  }
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(true)
    }
  })
  nameInput.addEventListener('blur', () => finish())

  item.insertBefore(nameInput, meta)
  nameInput.focus()
  nameInput.select()
}

function renameCard(cardId: string, requestedName: string): void {
  const deck = currentDeck()
  const card = deck.cards.find(item => item.id === cardId)
  if (!card) return

  const { base, number } = splitCardName(requestedName)
  const nextNumber = Math.max(number, Number(nextCardName(deck, base, cardId).split(' ').at(-1)))
  card.name = `${base} ${nextNumber}`
  renderCardThumbnails()
}

function moveCard(cardId: string, direction: -1 | 1): void {
  persistActiveDeckDocument()
  const deck = currentDeck()
  const index = deck.cards.findIndex((card) => card.id === cardId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= deck.cards.length) return
  const [card] = deck.cards.splice(index, 1)
  deck.cards.splice(target, 0, card)
  renderCardThumbnails()
}

function deleteCard(cardId: string): void {
  const deck = currentDeck()
  if (deck.cards.length <= 1) {
    window.alert('O baralho precisa ter ao menos 1 carta.')
    return
  }

  persistActiveDeckDocument()
  const index = deck.cards.findIndex((card) => card.id === cardId)
  if (index < 0) {
    return
  }

  const deletingActive = deck.activeCardId === cardId
  deck.cards.splice(index, 1)

  if (deletingActive) {
    const nextCard = deck.cards[Math.min(index, deck.cards.length - 1)]
    deck.activeCardId = nextCard.id
    void loadActiveDeckCard(deck, nextCard.id)
  }

  renderCardThumbnails()
}

function duplicateCard(cardId: string): void {
  persistActiveDeckDocument()
  const deck = currentDeck()
  const sourceIndex = deck.cards.findIndex((card) => card.id === cardId)
  if (sourceIndex < 0) return

  const sourceCard = deck.cards[sourceIndex]
  const sourceName = splitCardName(sourceCard.name)
  const duplicatedCard: CardState = {
    id: generateDeckId(),
    name: nextCardName(deck, sourceName.base),
    canvas: cloneCanvasState(sourceCard.canvas ?? createEmptyCanvasState()),
    deckObjects: deepClone(sourceCard.deckObjects),
    modelId: sourceCard.modelId,
    backId: sourceCard.backId,
    modelOverrides: deepClone(sourceCard.modelOverrides),
    thumbnail: sourceCard.thumbnail,
  }

  deck.cards.splice(sourceIndex + 1, 0, duplicatedCard)
  deck.activeCardId = duplicatedCard.id
  void loadActiveDeckCard(deck, duplicatedCard.id)
  renderCardThumbnails()
}

function renderWorkspaceSidebar(): void {
  deckNameInput.value = currentDeck().name
  renderWorkspaceTabs()
  applyDeckCover()
}

function applyDeckCover(): void {
  const cover = currentDeck().cover ?? ''
  const url = cover ? `url("${cover}")` : ''
  canvasCoverBg.style.backgroundImage = url
  deckCoverPreview.style.backgroundImage = url
  deckCoverRemoveButton.disabled = !cover
  const active = cover && coverMode !== 'off'
  canvasPanel.classList.toggle('has-cover', Boolean(active))
  canvasCoverBg.classList.toggle('is-blur', coverMode === 'blur')
  coverSwitchButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.coverMode === coverMode)
    button.disabled = !cover
  })
}

async function resizeCoverDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const aspectRatio = 16 / 9
  const sourceWidth = Math.min(bitmap.width, bitmap.height * aspectRatio)
  const sourceHeight = sourceWidth / aspectRatio
  const sourceX = (bitmap.width - sourceWidth) / 2
  const sourceY = (bitmap.height - sourceHeight) / 2
  const target = document.createElement('canvas')
  target.width = 1200
  target.height = Math.round(target.width / aspectRatio)
  target.getContext('2d')?.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, target.width, target.height)
  bitmap.close()
  return target.toDataURL('image/jpeg', 0.85)
}

async function loadDeckCanvas(state: ReturnType<Canvas['toObject']>): Promise<void> {
  return withLoading(async () => {
    canvas.clear()
    layerById.clear()
    await canvas.loadFromJSON(state)
    syncCanvasFrame()

    const objects = canvas.getObjects()
    objects.forEach((object) => {
      const meta = getLayerMeta(object)
      if (meta.kind === 'base') {
        setLayerMeta(object, { ...meta, kind: 'image', isBackground: true })
        if (object instanceof FabricImage) {
          const imageWidth = object.width ?? CARD_WIDTH
          const imageHeight = object.height ?? CARD_HEIGHT
          object.set({
            left: 0,
            top: 0,
            originX: 'left',
            originY: 'top',
            scaleX: CARD_WIDTH / imageWidth,
            scaleY: CARD_HEIGHT / imageHeight,
          })
          object.setCoords()
        }
      }

      const currentScope = normalizeScope((object.get('data') as Partial<LayerMeta> | undefined)?.scope, meta.kind)
      markObjectScope(object, currentScope)
      applyRuntimeConfig(object)
    })

    if (activeEditMode === 'deck') {
      canvas.getObjects().forEach((object) => {
        const meta = getLayerMeta(object)
        if (meta.kind !== 'image' || meta.scope !== 'model' || !(object instanceof FabricImage)) {
          return
        }

        // use saved slot dimensions – never recalculate from natural image size
        const fit = meta.isBackground ? 'fill' : normalizeImageFit(meta.fit ?? 'contain')
        const targetWidth = meta.isBackground ? CARD_WIDTH : Math.max(1, meta.slotWidth ?? object.getScaledWidth?.() ?? object.width ?? 1)
        const targetHeight = meta.isBackground ? CARD_HEIGHT : Math.max(1, meta.slotHeight ?? object.getScaledHeight?.() ?? object.height ?? 1)

        applyImageFit(object, fit, targetWidth, targetHeight, meta.cropPositionX, meta.cropPositionY)
        setLayerMeta(object, { ...meta, fit, slotWidth: targetWidth, slotHeight: targetHeight })
        object.setCoords()
      })
    }

    refreshLayerIndex()
    renderLayersAccordion()
    canvas.discardActiveObject()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
  })
}

function toHexColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function generateLayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  layerCount += 1
  return `layer-${Date.now()}-${layerCount}`
}

function setLayerMeta(object: FabricObject, meta: LayerMeta): void {
  object.set('data', meta)
}

function getLayerMeta(object: FabricObject): LayerMeta {
  const raw = object.get('data') as Partial<LayerMeta> | undefined
  const id = raw?.id ?? generateLayerId()
  const kind = raw?.kind ?? 'image'
  const name = raw?.name ?? `Layer ${id.slice(0, 4)}`
  const scope = normalizeScope(raw?.scope, kind)
  const meta: LayerMeta = {
    id,
    kind,
    name,
    scope,
    fit: kind === 'image' ? normalizeImageFit(raw?.fit ?? 'contain') : undefined,
    slotWidth: raw?.slotWidth,
    slotHeight: raw?.slotHeight,
    cropPositionX: typeof raw?.cropPositionX === 'number' ? clamp(0, 1, raw.cropPositionX) : 0.5,
    cropPositionY: typeof raw?.cropPositionY === 'number' ? clamp(0, 1, raw.cropPositionY) : 0.5,
    richTextSource: typeof raw?.richTextSource === 'string' ? raw.richTextSource : undefined,
    richTextFormat: raw?.richTextFormat === 'html' ? 'html' : 'tags',
    textVerticalAlign: normalizeTextVerticalAlign(raw?.textVerticalAlign),
    textOverflow: normalizeTextOverflow(raw?.textOverflow),
    textBoxHeight: typeof raw?.textBoxHeight === 'number' && raw.textBoxHeight > 0
      ? raw.textBoxHeight
      : isTextLayer(object) ? Math.max(1, object.height ?? 1) : undefined,
    graphicSource: typeof raw?.graphicSource === 'string' ? raw.graphicSource : undefined,
    scaleMode: raw?.scaleMode === 'nine-slice' ? 'nine-slice' : 'stretch',
    insetTop: Math.max(0, Number(raw?.insetTop) || 0),
    insetRight: Math.max(0, Number(raw?.insetRight) || 0),
    insetBottom: Math.max(0, Number(raw?.insetBottom) || 0),
    insetLeft: Math.max(0, Number(raw?.insetLeft) || 0),
    locked: raw?.locked === true,
    isBackground: raw?.isBackground === true || raw?.kind === 'base',
  }
  setLayerMeta(object, meta)
  return meta
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

function syncDeckFilename(): void {
  const name = deckNameInput.value
    .trim()
    .replace(/\.deck$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
  currentDeck().name = name || DEFAULT_DECK_NAME
  deckNameInput.value = currentDeck().name
}

function slugifyFilename(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'carta'
}

function buildExportFilename(): string {
  const textCandidates = canvas
    .getObjects()
    .filter((object): object is FabricText | Textbox => isTextLayer(object))
    .map((object) => {
      const text = String((object as FabricText | Textbox).text ?? '').trim()
      const numberMatch = text.match(/^(\d+)/)
      return {
        text,
        number: numberMatch ? Number(numberMatch[1]) : Number.POSITIVE_INFINITY,
      }
    })
    .filter(({ text }) => text.length > 0)

  if (textCandidates.length === 0) {
    const hashSource =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const shortHash = hashSource.replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase()
    return shortHash || 'carta'
  }

  textCandidates.sort((a, b) => a.number - b.number || a.text.localeCompare(b.text))
  return slugifyFilename(textCandidates[0].text)
}

function currentZoom(): number {
  return canvasDisplayZoom
}

function setCanvasZoom(zoom: number): void {
  const clamped = clamp(ZOOM_MIN, ZOOM_MAX, zoom)
  const displayWidth = CARD_WIDTH * clamped
  const displayHeight = CARD_HEIGHT * clamped

  canvasDisplayZoom = clamped
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  canvas.lowerCanvasEl.style.width = `${displayWidth}px`
  canvas.lowerCanvasEl.style.height = `${displayHeight}px`
  canvas.upperCanvasEl.style.width = `${displayWidth}px`
  canvas.upperCanvasEl.style.height = `${displayHeight}px`
  if (canvas.wrapperEl) {
    canvas.wrapperEl.style.width = `${displayWidth}px`
    canvas.wrapperEl.style.height = `${displayHeight}px`
  }
  zoomRange.value = String(Math.round(clamped * 100))
  zoomLabel.textContent = `${Math.round(clamped * 100)}%`
  canvas.requestRenderAll()
}

function fitCanvasZoomToStage(): void {
  const stageStyle = getComputedStyle(canvasStage)
  const horizontalPadding = Number.parseFloat(stageStyle.paddingLeft) + Number.parseFloat(stageStyle.paddingRight)
  const verticalPadding = Number.parseFloat(stageStyle.paddingTop) + Number.parseFloat(stageStyle.paddingBottom)
  const zoomToolbarAllowance = 58
  const availableWidth = Math.max(1, canvasStage.clientWidth - horizontalPadding - zoomToolbarAllowance - 4)
  const availableHeight = Math.max(1, canvasStage.clientHeight - verticalPadding - 4)
  const fit = Math.min(availableWidth / CARD_WIDTH, availableHeight / CARD_HEIGHT)
  setCanvasZoom(clamp(ZOOM_MIN, ZOOM_MAX, fit))
  canvasStage.scrollTo({ left: 0, top: 0 })
}

function attachNoDragPropagation(control: HTMLElement): void {
  control.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('mousedown', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('touchstart', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('dragstart', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
}

function isTextLayer(object: FabricObject): object is FabricText | Textbox {
  return object instanceof FabricText || object instanceof Textbox
}

function layerKindLabel(kind: LayerKind): string {
  const labels: Record<LayerKind, string> = { base: 'base', image: 'imagem', text: 'texto', shape: 'forma', graphic: 'gráfico' }
  return labels[kind]
}

function applyRuntimeConfig(object: FabricObject): void {
  const meta = getLayerMeta(object)
  if (isTextLayer(object) && object.textAlign === 'justify') {
    object.set({ textAlign: 'left' })
  }
  const canEditCardModelContent =
    activeEditMode === 'deck' && meta.scope === 'model' && (meta.kind === 'text' || meta.kind === 'image')

  object.set({
    cornerStyle: 'circle',
    borderColor: '#cc4f1d',
    cornerColor: '#cc4f1d',
    transparentCorners: false,
    padding: 4,
  })

  const fullyEditable = meta.scope === activeEditMode
  const contentOnlyEditable = !fullyEditable && canEditCardModelContent
  const selectable = fullyEditable || contentOnlyEditable
  const positionLocked = meta.locked || meta.isBackground

  object.set({
    selectable,
    evented: selectable,
    lockMovementX: !fullyEditable || positionLocked,
    lockMovementY: !fullyEditable || positionLocked,
    lockRotation: !fullyEditable || positionLocked,
    lockScalingX: !fullyEditable || positionLocked,
    lockScalingY: !fullyEditable || positionLocked,
    hasControls: fullyEditable && !positionLocked,
    editable: meta.kind === 'text' && selectable,
  })
}

function refreshLayerIndex(): void {
  layerById.clear()
  canvas.getObjects().forEach((object) => {
    const meta = getLayerMeta(object)
    layerById.set(meta.id, object)
  })
}

function selectedLayerId(): string | null {
  const active = canvas.getActiveObject()
  if (!active || active instanceof ActiveSelection) {
    return null
  }
  return getLayerMeta(active).id
}

function selectLayer(layerId: string): void {
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  const meta = getLayerMeta(object)
  if (meta.scope !== activeEditMode) {
    return
  }

  suppressSelectionSync = true
  canvas.setActiveObject(object)
  suppressSelectionSync = false
  canvas.requestRenderAll()
  renderLayersAccordion()
}

function removeLayer(layerId: string): void {
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  if (getLayerMeta(object).scope !== activeEditMode) {
    return
  }

  canvas.remove(object)
  refreshLayerIndex()
  persistActiveDeckDocument()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function moveLayer(layerId: string, direction: 'up' | 'down'): void {
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  const meta = getLayerMeta(object)
  if (meta.scope !== activeEditMode) {
    return
  }

  const objects = canvas.getObjects()
  const currentIndex = objects.indexOf(object)
  if (currentIndex < 0) {
    return
  }

  const target = direction === 'up' ? currentIndex + 1 : currentIndex - 1
  const nextIndex = clamp(0, objects.length - 1, target)

  if (nextIndex === currentIndex) {
    return
  }

  canvas.moveObjectTo(object, nextIndex)
  refreshLayerIndex()
  persistActiveDeckDocument()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function reorderLayersByAccordion(sourceLayerId: string, targetLayerId: string): void {
  if (sourceLayerId === targetLayerId) {
    return
  }

  const objects = canvas.getObjects()
  const ordered = [...objects].reverse()
  const fromIndex = ordered.findIndex((item) => getLayerMeta(item).id === sourceLayerId)
  const toIndex = ordered.findIndex((item) => getLayerMeta(item).id === targetLayerId)

  if (fromIndex < 0 || toIndex < 0) {
    return
  }

  const sourceMeta = getLayerMeta(ordered[fromIndex])
  const targetMeta = getLayerMeta(ordered[toIndex])
  if (sourceMeta.scope !== activeEditMode || targetMeta.scope !== activeEditMode) {
    return
  }

  const [moved] = ordered.splice(fromIndex, 1)
  ordered.splice(toIndex, 0, moved)

  const total = ordered.length
  ordered.forEach((item, displayIndex) => {
    const canvasIndex = total - 1 - displayIndex
    canvas.moveObjectTo(item, canvasIndex)
  })

  refreshLayerIndex()
  persistActiveDeckDocument()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function setLayerLocked(layerId: string, locked: boolean): void {
  const object = layerById.get(layerId)
  if (!object) return
  const meta = getLayerMeta(object)
  setLayerMeta(object, { ...meta, locked })
  applyRuntimeConfig(object)
  persistActiveDeckDocument()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function setLayerBackground(layerId: string, enabled: boolean): void {
  const object = layerById.get(layerId)
  if (!object) return
  const meta = getLayerMeta(object)
  const nextMeta = {
    ...meta,
    isBackground: enabled,
    ...(enabled && object instanceof FabricImage ? { fit: 'fill' as const, slotWidth: CARD_WIDTH, slotHeight: CARD_HEIGHT } : {}),
  }
  setLayerMeta(object, nextMeta)
  if (enabled) {
    object.set({
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: CARD_WIDTH / Math.max(1, object.width ?? 1),
      scaleY: CARD_HEIGHT / Math.max(1, object.height ?? 1),
    })
  }
  applyRuntimeConfig(object)
  object.setCoords()
  persistActiveDeckDocument()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function detailsRow(labelText: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'layer-detail-row'

  const label = document.createElement('label')
  label.textContent = labelText
  if (control instanceof HTMLInputElement && control.type === 'range') {
    const slider = document.createElement('span')
    slider.className = 'layer-range-control'
    const value = document.createElement('output')
    value.className = 'layer-range-value'
    const updateValue = (): void => {
      const numericValue = Number(control.value)
      const precision = Math.max(0, (control.step.split('.')[1] ?? '').length)
      value.value = numericValue.toFixed(precision)
      value.textContent = value.value
    }
    updateValue()
    control.addEventListener('input', updateValue)
    slider.append(control, value)
    label.append(slider)
  } else {
    label.append(control)
  }
  row.append(label)

  return row
}

function createFontSelect(currentFont: string): HTMLSelectElement {
  const select = document.createElement('select')

  FONT_OPTIONS.forEach((fontName) => {
    const option = document.createElement('option')
    option.value = fontName
    option.textContent = fontName
    if (fontName === currentFont) {
      option.selected = true
    }
    select.append(option)
  })

  return select
}

function isEditingField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true
  }

  return target.isContentEditable
}

function removeSelectedLayer(): void {
  const activeObject = canvas.getActiveObject()
  if (!activeObject) {
    return
  }

  const meta = getLayerMeta(activeObject)
  if (meta.scope !== activeEditMode) {
    return
  }

  if (isTextLayer(activeObject) && (activeObject as unknown as { isEditing?: boolean }).isEditing) {
    return
  }

  canvas.discardActiveObject()
  removeLayer(meta.id)
}

function nudgeSelectedLayer(key: string): boolean {
  const activeObject = canvas.getActiveObject()
  if (!activeObject) {
    return false
  }

  const meta = getLayerMeta(activeObject)
  if (meta.scope !== activeEditMode || meta.locked || meta.isBackground) {
    return false
  }

  const canMoveByArrow = activeObject instanceof FabricImage || isTextLayer(activeObject)
  if (!canMoveByArrow) {
    return false
  }

  if (isTextLayer(activeObject) && (activeObject as unknown as { isEditing?: boolean }).isEditing) {
    return false
  }

  const currentLeft = activeObject.left ?? 0
  const currentTop = activeObject.top ?? 0

  if (key === 'ArrowLeft') {
    activeObject.set({ left: currentLeft - 1 })
  } else if (key === 'ArrowRight') {
    activeObject.set({ left: currentLeft + 1 })
  } else if (key === 'ArrowUp') {
    activeObject.set({ top: currentTop - 1 })
  } else if (key === 'ArrowDown') {
    activeObject.set({ top: currentTop + 1 })
  } else {
    return false
  }

  activeObject.setCoords()
  canvas.requestRenderAll()
  renderLayersAccordion()
  return true
}

function renderLayersAccordion(): void {
  refreshLayerIndex()
  layersAccordion.innerHTML = ''

  const objects = canvas.getObjects()
  const activeId = selectedLayerId()
  const ordered = [...objects].reverse()

  ordered.forEach((object, reverseIndex) => {
    const meta = getLayerMeta(object)
    const zFromTop = reverseIndex
    const editable = meta.scope === activeEditMode
    const scopeLabel = meta.scope === 'model' ? 'Modelo' : 'Baralho'

    const details = document.createElement('details')
    details.className = `layer-item ${meta.id === activeId ? 'is-active' : ''}`
    details.open = meta.id === activeId
    details.dataset.layerId = meta.id

    details.addEventListener('dragover', (event) => {
      event.preventDefault()
      if (draggedLayerId && draggedLayerId !== meta.id) {
        details.classList.add('drag-over')
      }
    })

    details.addEventListener('dragleave', () => {
      details.classList.remove('drag-over')
    })

    details.addEventListener('drop', (event) => {
      event.preventDefault()
      details.classList.remove('drag-over')
      const source = draggedLayerId ?? event.dataTransfer?.getData('text/plain')
      if (!source) {
        return
      }
      reorderLayersByAccordion(source, meta.id)
    })

    const summary = document.createElement('summary')
    summary.className = 'layer-summary'
    summary.draggable = editable
    const nameLabel = document.createElement('span')
    nameLabel.className = 'layer-name'
    nameLabel.textContent = meta.name
    const kindLabel = document.createElement('span')
    kindLabel.className = 'layer-kind'
    kindLabel.textContent = `${scopeLabel} • ${layerKindLabel(meta.kind)}`
    const zLabel = document.createElement('span')
    zLabel.className = 'layer-z'
    zLabel.textContent = `z:${zFromTop}`
    summary.append(nameLabel, kindLabel, zLabel)

    summary.addEventListener('dragstart', (event) => {
      if (!editable) {
        event.preventDefault()
        return
      }
      draggedLayerId = meta.id
      event.dataTransfer?.setData('text/plain', meta.id)
      event.dataTransfer?.setDragImage(details, 24, 20)
      details.classList.add('is-dragging')
    })

    summary.addEventListener('dragend', () => {
      draggedLayerId = null
      details.classList.remove('is-dragging')
      layersAccordion
        .querySelectorAll<HTMLElement>('.layer-item.drag-over')
        .forEach((node) => node.classList.remove('drag-over'))
    })

    summary.addEventListener('click', () => {
      selectLayer(meta.id)
    })

    const actions = document.createElement('div')
    actions.className = 'layer-actions'

    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = 'tiny ghost'
    selectBtn.textContent = 'Selecionar'
    selectBtn.disabled = !editable
    selectBtn.addEventListener('click', (event) => {
      event.preventDefault()
      selectLayer(meta.id)
    })

    const renameBtn = document.createElement('button')
    renameBtn.type = 'button'
    renameBtn.className = 'tiny ghost layer-toggle'
    renameBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">edit</span>'
    renameBtn.title = `Renomear layer ${meta.name}`
    renameBtn.setAttribute('aria-label', renameBtn.title)
    renameBtn.disabled = !editable
    renameBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'layer-name-edit'
      input.value = getLayerMeta(object).name
      input.maxLength = 80
      input.setAttribute('aria-label', `Nome da layer ${meta.name}`)
      attachNoDragPropagation(input)
      input.addEventListener('click', (inputEvent) => inputEvent.stopPropagation())

      let finished = false
      const finishRename = (save: boolean): void => {
        if (finished) return
        finished = true
        const nextName = input.value.trim()
        if (save && nextName) {
          setLayerMeta(object, { ...getLayerMeta(object), name: nextName })
          persistActiveDeckDocument()
        }
        canvas.requestRenderAll()
        renderLayersAccordion()
      }

      input.addEventListener('keydown', (keyEvent) => {
        keyEvent.stopPropagation()
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          finishRename(true)
        } else if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          finishRename(false)
        }
      })
      input.addEventListener('blur', () => finishRename(true))
      nameLabel.replaceWith(input)
      input.focus()
      input.select()
    })

    const upBtn = document.createElement('button')
    upBtn.type = 'button'
    upBtn.className = 'tiny ghost'
    upBtn.textContent = 'Subir'
    upBtn.disabled = zFromTop === 0 || !editable
    upBtn.addEventListener('click', (event) => {
      event.preventDefault()
      moveLayer(meta.id, 'up')
    })

    const downBtn = document.createElement('button')
    downBtn.type = 'button'
    downBtn.className = 'tiny ghost'
    downBtn.textContent = 'Descer'
    downBtn.disabled = zFromTop === objects.length - 1 || !editable
    downBtn.addEventListener('click', (event) => {
      event.preventDefault()
      moveLayer(meta.id, 'down')
    })

    actions.append(selectBtn, renameBtn, upBtn, downBtn)

    const lockBtn = document.createElement('button')
    lockBtn.type = 'button'
    lockBtn.className = `tiny ghost layer-toggle ${meta.locked ? 'is-active' : ''}`
    lockBtn.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${meta.locked ? 'lock' : 'lock_open'}</span>`
    lockBtn.title = meta.locked ? 'Destravar posicionamento' : 'Travar posicionamento'
    lockBtn.setAttribute('aria-label', lockBtn.title)
    lockBtn.disabled = !editable
    lockBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      setLayerLocked(meta.id, !meta.locked)
    })

    const backgroundBtn = document.createElement('button')
    backgroundBtn.type = 'button'
    backgroundBtn.className = `tiny ghost layer-toggle ${meta.isBackground ? 'is-active' : ''}`
    backgroundBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">wallpaper</span>'
    backgroundBtn.title = meta.isBackground ? 'Remover comportamento de background' : 'Usar como background da carta'
    backgroundBtn.setAttribute('aria-label', backgroundBtn.title)
    backgroundBtn.disabled = !editable
    backgroundBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      setLayerBackground(meta.id, !meta.isBackground)
    })
    actions.append(lockBtn, backgroundBtn)

    {
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'tiny danger'
      removeBtn.textContent = 'Remover'
      removeBtn.disabled = !editable
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault()
        removeLayer(meta.id)
      })
      actions.append(removeBtn)
    }

    details.append(summary, actions)
    layersAccordion.append(details)
  })

  renderEditorPanel()
}

function buildLayerBody(object: FabricObject, meta: LayerMeta, editable: boolean, body: HTMLElement): void {
    if (!editable) {
      const canEditCardContent =
        activeEditMode === 'deck' &&
        meta.scope === 'model' &&
        (meta.kind === 'text' || meta.kind === 'image')

      if (canEditCardContent) {
        const note = document.createElement('p')
        note.className = 'layer-note'
        note.textContent =
          'Conteudo individual desta carta: altere texto/ilustracao sem mover ou redimensionar o layer do modelo. Dê duplo clique na imagem para trocar.'
        body.append(note)

        if (meta.kind === 'text' && isTextLayer(object)) {
          const textObject = object as FabricText | Textbox
          const commitCardTextChanges = () => {
            textObject.setCoords()
            canvas.requestRenderAll()
            persistActiveDeckDocument()
            renderCardThumbnails()
          }

          renderRichTextEditor(body, textObject, commitCardTextChanges)

          const hint = document.createElement('p')
          hint.className = 'layer-note'
          hint.textContent =
            'Cores por trecho: use <verde>texto</verde>, <#ff8800>texto</#ff8800>, [cor=verde]texto[/cor] ou [color=#ff8800]texto[/color].'
          body.append(hint)

          const textField = document.createElement('textarea')
          textField.rows = 3
          textField.value = meta.richTextSource ?? String((textObject as any).text ?? '')
          attachNoDragPropagation(textField)
          textField.addEventListener('input', () => {
            applyTaggedTextToObject(textObject, textField.value)
            commitCardTextChanges()
          })
          body.append(detailsRow('Texto da carta (com tags)', textField))
          body.addEventListener('rich-text-sync', () => { textField.value = textObjectToTagMarkup(textObject) })

          const tagSyntaxField = document.createElement('select')
          attachNoDragPropagation(tagSyntaxField)
          ;[
            { value: 'html', label: '<verde>texto</verde>' },
            { value: 'bbcode', label: '[cor=verde]texto[/cor]' },
          ].forEach((item) => {
            const option = document.createElement('option')
            option.value = item.value
            option.textContent = item.label
            tagSyntaxField.append(option)
          })
          body.append(detailsRow('Formato da tag de cor', tagSyntaxField))

          const palette = document.createElement('div')
          palette.className = 'text-color-palette'
          const paletteEntries: Array<{ label: string; token: string; color: string }> = [
            { label: 'Verde', token: 'verde', color: '#2f9e44' },
            { label: 'Vermelho', token: 'vermelho', color: '#d90429' },
            { label: 'Azul', token: 'azul', color: '#1971c2' },
            { label: 'Amarelo', token: 'amarelo', color: '#f08c00' },
            { label: 'Roxo', token: 'roxo', color: '#6f42c1' },
            { label: 'Rosa', token: 'rosa', color: '#d63384' },
            { label: 'Preto', token: 'preto', color: '#111111' },
            { label: 'Branco', token: 'branco', color: '#ffffff' },
            { label: 'Bronze', token: 'bronze', color: '#cd7f32' },
            { label: 'Prata', token: 'prata', color: '#a8a9ad' },
          ]

          paletteEntries.forEach(({ label, token, color }) => {
            const swatch = document.createElement('button')
            swatch.type = 'button'
            swatch.className = 'text-color-swatch'
            swatch.title = `Aplicar ${label}`
            swatch.setAttribute('aria-label', `Aplicar ${label}`)
            swatch.style.setProperty('--swatch-color', color)
            swatch.addEventListener('click', () => {
              wrapSelectionWithColor(textField, token, tagSyntaxField.value === 'bbcode' ? 'bbcode' : 'html')
            })
            palette.append(swatch)
          })
          body.append(detailsRow('Paleta rápida', palette))
          body.append(detailsRow('Meus 5 estilos', createSavedTextColorPalette((style) => {
            wrapSelectionWithColor(textField, style.color, tagSyntaxField.value === 'bbcode' ? 'bbcode' : 'html')
          })))

          const customColorField = document.createElement('input')
          customColorField.type = 'color'
          customColorField.value = '#ff8800'
          attachNoDragPropagation(customColorField)
          body.append(detailsRow('Tag com cor personalizada', customColorField))

          const applyCustomColorButton = document.createElement('button')
          applyCustomColorButton.type = 'button'
          applyCustomColorButton.className = 'tiny ghost'
          applyCustomColorButton.textContent = 'Aplicar cor na selecao'
          applyCustomColorButton.addEventListener('click', () => {
            wrapSelectionWithColor(
              textField,
              customColorField.value,
              tagSyntaxField.value === 'bbcode' ? 'bbcode' : 'html',
            )
          })
          body.append(detailsRow('Aplicar cor custom', applyCustomColorButton))

          const fontFamilyField = createFontSelect(String((textObject as any).fontFamily ?? 'Arial'))
          attachNoDragPropagation(fontFamilyField)
          fontFamilyField.addEventListener('change', () => {
            textObject.set({ fontFamily: fontFamilyField.value })
            commitCardTextChanges()
          })
          body.append(detailsRow('Fonte', fontFamilyField))

          const fontSizeField = document.createElement('input')
          fontSizeField.type = 'number'
          fontSizeField.min = '8'
          fontSizeField.max = '220'
          fontSizeField.step = '1'
          fontSizeField.value = String((textObject as any).fontSize ?? 40)
          attachNoDragPropagation(fontSizeField)
          fontSizeField.addEventListener('input', () => {
            textObject.set({ fontSize: clamp(8, 220, Number(fontSizeField.value) || 40) })
            commitCardTextChanges()
          })
          body.append(detailsRow('Tamanho', fontSizeField))

          const fillField = document.createElement('input')
          fillField.type = 'color'
          fillField.value = toHexColor(String((textObject as any).fill ?? '#1c2738'), '#1c2738')
          attachNoDragPropagation(fillField)
          fillField.addEventListener('input', () => {
            textObject.set({ fill: fillField.value })
            const currentMeta = getLayerMeta(textObject)
            const sourceText = currentMeta.richTextSource ?? String((textObject as any).text ?? '')
            applyRichTextToObject(textObject, sourceText, currentMeta.richTextFormat ?? 'tags')
            commitCardTextChanges()
          })
          body.append(detailsRow('Cor base do texto', fillField))

          const strokeColorField = document.createElement('input')
          strokeColorField.type = 'color'
          strokeColorField.value = toHexColor(String((textObject as any).stroke ?? '#000000'), '#000000')
          attachNoDragPropagation(strokeColorField)
          strokeColorField.addEventListener('input', () => {
            textObject.set({ stroke: strokeColorField.value })
            commitCardTextChanges()
          })
          body.append(detailsRow('Cor da borda', strokeColorField))

          const strokeWidthField = document.createElement('input')
          strokeWidthField.type = 'number'
          strokeWidthField.min = '0'
          strokeWidthField.max = '20'
          strokeWidthField.step = '0.2'
          strokeWidthField.value = String((textObject as any).strokeWidth ?? 0)
          attachNoDragPropagation(strokeWidthField)
          strokeWidthField.addEventListener('input', () => {
            textObject.set({ strokeWidth: clamp(0, 20, Number(strokeWidthField.value) || 0) })
            commitCardTextChanges()
          })
          body.append(detailsRow('Espessura da borda', strokeWidthField))

          body.append(createTextLayoutControls(textObject, commitCardTextChanges))

          const lineHeightField = document.createElement('input')
          lineHeightField.type = 'number'
          lineHeightField.min = '0.6'
          lineHeightField.max = '3'
          lineHeightField.step = '0.05'
          lineHeightField.value = String((textObject as any).lineHeight ?? 1.16)
          attachNoDragPropagation(lineHeightField)
          lineHeightField.addEventListener('input', () => {
            textObject.set({ lineHeight: clamp(0.6, 3, Number(lineHeightField.value) || 1.16) })
            commitCardTextChanges()
          })
          body.append(detailsRow('Espacamento de linha', lineHeightField))

          const boldField = document.createElement('input')
          boldField.type = 'checkbox'
          boldField.checked = String((textObject as any).fontWeight ?? '').toLowerCase() === 'bold'
          attachNoDragPropagation(boldField)
          boldField.addEventListener('change', () => {
            textObject.set({ fontWeight: boldField.checked ? 'bold' : 'normal' })
            commitCardTextChanges()
          })
          body.append(detailsRow('Negrito', boldField))

          const italicField = document.createElement('input')
          italicField.type = 'checkbox'
          italicField.checked = String((textObject as any).fontStyle ?? '').toLowerCase() === 'italic'
          attachNoDragPropagation(italicField)
          italicField.addEventListener('change', () => {
            textObject.set({ fontStyle: italicField.checked ? 'italic' : 'normal' })
            commitCardTextChanges()
          })
          body.append(detailsRow('Italico', italicField))

          const underlineField = document.createElement('input')
          underlineField.type = 'checkbox'
          underlineField.checked = Boolean((textObject as any).underline)
          attachNoDragPropagation(underlineField)
          underlineField.addEventListener('change', () => {
            textObject.set({ underline: underlineField.checked })
            commitCardTextChanges()
          })
          body.append(detailsRow('Sublinhado', underlineField))

          const rawShadow = (textObject as any).shadow as
            | { color?: string; blur?: number; offsetX?: number; offsetY?: number }
            | null
          const shadowEnabledField = document.createElement('input')
          shadowEnabledField.type = 'checkbox'
          shadowEnabledField.checked = Boolean(rawShadow)
          attachNoDragPropagation(shadowEnabledField)
          body.append(detailsRow('Sombra', shadowEnabledField))

          const shadowColorField = document.createElement('input')
          shadowColorField.type = 'color'
          shadowColorField.value = toHexColor(String(rawShadow?.color ?? '#000000'), '#000000')
          attachNoDragPropagation(shadowColorField)
          body.append(detailsRow('Cor da sombra', shadowColorField))

          const shadowBlurField = document.createElement('input')
          shadowBlurField.type = 'number'
          shadowBlurField.min = '0'
          shadowBlurField.max = '60'
          shadowBlurField.step = '1'
          shadowBlurField.value = String(rawShadow?.blur ?? 0)
          attachNoDragPropagation(shadowBlurField)
          body.append(detailsRow('Blur da sombra', shadowBlurField))

          const applyShadow = () => {
            if (!shadowEnabledField.checked) {
              textObject.set({ shadow: null })
            } else {
              textObject.set({
                shadow: {
                  color: shadowColorField.value,
                  blur: clamp(0, 60, Number(shadowBlurField.value) || 0),
                  offsetX: 2,
                  offsetY: 2,
                },
              })
            }
            commitCardTextChanges()
          }

          shadowEnabledField.addEventListener('change', applyShadow)
          shadowColorField.addEventListener('input', applyShadow)
          shadowBlurField.addEventListener('input', applyShadow)
          removeLegacyTaggedTextControls(body)
        }

        if (meta.kind === 'image' && object instanceof FabricImage) {
          body.append(createImageBehaviorControls(object))
        }

        return
      }

      const lockNote = document.createElement('p')
      lockNote.className = 'layer-note'
      lockNote.textContent =
        meta.scope === 'model'
          ? 'Este layer pertence ao modelo. Troque para a aba Modelo para editar.'
          : 'Este layer pertence ao baralho. Troque para a aba Baralhos para editar.'
      body.append(lockNote)
      return
    }

    if (activeEditMode === 'model') {
      body.append(createLayerAttributeTransferControls(object))
    }

    const xInput = document.createElement('input')
    xInput.type = 'number'
    xInput.step = '1'
    xInput.value = String(Math.round(object.left ?? 0))
    xInput.disabled = Boolean(meta.locked || meta.isBackground)
    attachNoDragPropagation(xInput)
    xInput.addEventListener('input', () => {
      object.set({ left: Number(xInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('X', xInput))

    const yInput = document.createElement('input')
    yInput.type = 'number'
    yInput.step = '1'
    yInput.value = String(Math.round(object.top ?? 0))
    yInput.disabled = Boolean(meta.locked || meta.isBackground)
    attachNoDragPropagation(yInput)
    yInput.addEventListener('input', () => {
      object.set({ top: Number(yInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Y', yInput))

    const opacityInput = document.createElement('input')
    opacityInput.type = 'range'
    opacityInput.min = '0'
    opacityInput.max = '1'
    opacityInput.step = '0.01'
    opacityInput.value = String(object.opacity ?? 1)
    attachNoDragPropagation(opacityInput)
    opacityInput.addEventListener('input', () => {
      object.set({ opacity: Number(opacityInput.value) || 1 })
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Opacidade', opacityInput))

    const scaleInput = document.createElement('input')
    scaleInput.type = 'range'
    scaleInput.min = '0.1'
    scaleInput.max = '3'
    scaleInput.step = '0.01'
    scaleInput.value = String(object.scaleX ?? 1)
    scaleInput.disabled = Boolean(meta.locked || meta.isBackground)
    attachNoDragPropagation(scaleInput)
    scaleInput.addEventListener('input', () => {
      const scale = Number(scaleInput.value) || 1
      object.set({ scaleX: scale, scaleY: scale })
      object.setCoords()
      canvas.requestRenderAll()
    })
    if (!isTextLayer(object)) {
      body.append(detailsRow('Escala', scaleInput))
    }

    const angleInput = document.createElement('input')
    angleInput.type = 'range'
    angleInput.min = '-180'
    angleInput.max = '180'
    angleInput.step = '1'
    angleInput.value = String(object.angle ?? 0)
    angleInput.disabled = Boolean(meta.locked || meta.isBackground)
    attachNoDragPropagation(angleInput)
    angleInput.addEventListener('input', () => {
      object.set({ angle: Number(angleInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Rotacao', angleInput))

    if (meta.kind === 'shape') {
      body.append(createShapeControls(object))
    }

    if (meta.kind === 'graphic') {
      body.append(createGraphicSizeControls(object))
      body.append(createGraphicScaleControls(object))
    }

    if (isTextLayer(object)) {
      const textObject = object as FabricText | Textbox

      renderRichTextEditor(body, textObject, () => {
        textObject.setCoords()
        canvas.requestRenderAll()
        persistActiveDeckDocument()
      })

      const textHint = document.createElement('p')
      textHint.className = 'layer-note'
      textHint.textContent =
        'Selecione um trecho e aplique uma cor. Exemplo: role um <bronze>D10</bronze> e um <prata>D2</prata>.'
      body.append(textHint)

      const textField = document.createElement('textarea')
      textField.rows = 3
      textField.value = getLayerMeta(textObject).richTextSource ?? String((textObject as any).text ?? 'Texto')
      attachNoDragPropagation(textField)
      textField.addEventListener('input', () => {
        applyTaggedTextToObject(textObject, textField.value)
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Texto (com cores por trecho)', textField))
      body.addEventListener('rich-text-sync', () => { textField.value = textObjectToTagMarkup(textObject) })

      const textPalette = document.createElement('div')
      textPalette.className = 'text-color-palette'
      ;[
        { label: 'Bronze', token: 'bronze', color: '#cd7f32' },
        { label: 'Prata', token: 'prata', color: '#a8a9ad' },
        { label: 'Dourado', token: 'dourado', color: '#d4a017' },
        { label: 'Verde', token: 'verde', color: '#2f9e44' },
        { label: 'Vermelho', token: 'vermelho', color: '#d90429' },
        { label: 'Azul', token: 'azul', color: '#1971c2' },
        { label: 'Roxo', token: 'roxo', color: '#6f42c1' },
      ].forEach(({ label, token, color }) => {
        const swatch = document.createElement('button')
        swatch.type = 'button'
        swatch.className = 'text-color-swatch'
        swatch.title = `Aplicar ${label}`
        swatch.setAttribute('aria-label', `Aplicar ${label}`)
        swatch.style.setProperty('--swatch-color', color)
        swatch.addEventListener('click', () => wrapSelectionWithColor(textField, token, 'html'))
        textPalette.append(swatch)
      })
      body.append(detailsRow('Cores rápidas', textPalette))
      body.append(detailsRow('Meus 5 estilos', createSavedTextColorPalette((style) => {
        wrapSelectionWithColor(textField, style.color, 'html')
      })))

      const customInlineColor = document.createElement('input')
      customInlineColor.type = 'color'
      customInlineColor.value = '#cd7f32'
      attachNoDragPropagation(customInlineColor)
      const applyInlineColor = document.createElement('button')
      applyInlineColor.type = 'button'
      applyInlineColor.className = 'tiny ghost'
      applyInlineColor.textContent = 'Aplicar à seleção'
      applyInlineColor.addEventListener('click', () => {
        wrapSelectionWithColor(textField, customInlineColor.value, 'html')
      })
      const customInlineControls = document.createElement('div')
      customInlineControls.className = 'inline-color-controls'
      customInlineControls.append(customInlineColor, applyInlineColor)
      body.append(detailsRow('Cor personalizada', customInlineControls))

      const fontFamilyField = createFontSelect(String((textObject as any).fontFamily ?? 'Arial'))
      attachNoDragPropagation(fontFamilyField)
      fontFamilyField.addEventListener('change', () => {
        textObject.set({ fontFamily: fontFamilyField.value })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Fonte', fontFamilyField))

      const fontSizeField = document.createElement('input')
      fontSizeField.type = 'number'
      fontSizeField.min = '8'
      fontSizeField.max = '220'
      fontSizeField.value = String((textObject as any).fontSize ?? 40)
      attachNoDragPropagation(fontSizeField)
      fontSizeField.addEventListener('input', () => {
        textObject.set({ fontSize: clamp(8, 220, Number(fontSizeField.value) || 40) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Tamanho', fontSizeField))

      const fillField = document.createElement('input')
      fillField.type = 'color'
      fillField.value = toHexColor(String((textObject as any).fill ?? '#1c2738'), '#1c2738')
      attachNoDragPropagation(fillField)
      fillField.addEventListener('input', () => {
        textObject.set({ fill: fillField.value })
        const currentMeta = getLayerMeta(textObject)
        const sourceText = currentMeta.richTextSource ?? String((textObject as any).text ?? '')
        applyRichTextToObject(textObject, sourceText, currentMeta.richTextFormat ?? 'tags')
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Cor base do texto', fillField))

      const strokeColorField = document.createElement('input')
      strokeColorField.type = 'color'
      const strokeColor = toHexColor(String((textObject as any).stroke ?? '#000000'), '#000000')
      strokeColorField.value = strokeColor
      attachNoDragPropagation(strokeColorField)
      strokeColorField.addEventListener('input', () => {
        textObject.set({ stroke: strokeColorField.value })
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Cor da borda', strokeColorField))

      const strokeWidthField = document.createElement('input')
      strokeWidthField.type = 'number'
      strokeWidthField.min = '0'
      strokeWidthField.max = '20'
      strokeWidthField.step = '0.2'
      strokeWidthField.value = String((textObject as any).strokeWidth ?? 0)
      attachNoDragPropagation(strokeWidthField)
      strokeWidthField.addEventListener('input', () => {
        textObject.set({ strokeWidth: clamp(0, 20, Number(strokeWidthField.value) || 0) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Espessura da borda', strokeWidthField))

      body.append(createTextLayoutControls(textObject, () => {
        textObject.setCoords()
        canvas.requestRenderAll()
        persistActiveDeckDocument()
      }))

      const lineHeightField = document.createElement('input')
      lineHeightField.type = 'number'
      lineHeightField.min = '0.6'
      lineHeightField.max = '3'
      lineHeightField.step = '0.05'
      lineHeightField.value = String((textObject as any).lineHeight ?? 1.16)
      attachNoDragPropagation(lineHeightField)
      lineHeightField.addEventListener('input', () => {
        textObject.set({ lineHeight: clamp(0.6, 3, Number(lineHeightField.value) || 1.16) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Espacamento de linha', lineHeightField))

      const textStyleControls = document.createElement('div')
      textStyleControls.className = 'text-style-controls'
      ;[
        {
          label: 'Tachado',
          checked: Boolean((textObject as any).linethrough),
          apply: (enabled: boolean) => textObject.set({ linethrough: enabled }),
        },
      ].forEach((style) => {
        const label = document.createElement('label')
        label.className = 'text-style-option'
        const field = document.createElement('input')
        field.type = 'checkbox'
        field.checked = style.checked
        attachNoDragPropagation(field)
        field.addEventListener('change', () => {
          style.apply(field.checked)
          textObject.setCoords()
          canvas.requestRenderAll()
          persistActiveDeckDocument()
        })
        const caption = document.createElement('span')
        caption.textContent = style.label
        label.append(field, caption)
        textStyleControls.append(label)
      })
      body.append(detailsRow('Estilo do texto', textStyleControls))

      const rawShadow = (textObject as any).shadow as
        | { color?: string; blur?: number; offsetX?: number; offsetY?: number }
        | null
      const shadowEnabledField = document.createElement('input')
      shadowEnabledField.type = 'checkbox'
      shadowEnabledField.checked = Boolean(rawShadow)
      attachNoDragPropagation(shadowEnabledField)
      body.append(detailsRow('Sombra', shadowEnabledField))

      const shadowColorField = document.createElement('input')
      shadowColorField.type = 'color'
      shadowColorField.value = toHexColor(String(rawShadow?.color ?? '#000000'), '#000000')
      attachNoDragPropagation(shadowColorField)
      body.append(detailsRow('Cor da sombra', shadowColorField))

      const shadowBlurField = document.createElement('input')
      shadowBlurField.type = 'number'
      shadowBlurField.min = '0'
      shadowBlurField.max = '60'
      shadowBlurField.step = '1'
      shadowBlurField.value = String(rawShadow?.blur ?? 0)
      attachNoDragPropagation(shadowBlurField)
      body.append(detailsRow('Blur da sombra', shadowBlurField))

      const applyShadow = () => {
        if (!shadowEnabledField.checked) {
          textObject.set({ shadow: null })
        } else {
          textObject.set({
            shadow: {
              color: shadowColorField.value,
              blur: clamp(0, 60, Number(shadowBlurField.value) || 0),
              offsetX: 2,
              offsetY: 2,
            },
          })
        }
        textObject.setCoords()
        canvas.requestRenderAll()
      }

      shadowEnabledField.addEventListener('change', applyShadow)
      shadowColorField.addEventListener('input', applyShadow)
      shadowBlurField.addEventListener('input', applyShadow)
      removeLegacyTaggedTextControls(body)
    }

    if (meta.kind === 'image' && object instanceof FabricImage) {
      body.append(createImageBehaviorControls(object))
    }
}

async function fileToObjectUrl(file: File): Promise<string> {
  return withLoading(async () => {
    // Fabric and history keep this URL; unlike a data URL, it references the original Blob without a Base64 copy.
    return URL.createObjectURL(file)
  })
}

async function addImageLayer(url: string, name = 'Imagem'): Promise<void> {
  return withLoading(async () => {
    const image = await FabricImage.fromURL(url)

    const maxWidth = CARD_WIDTH * 0.62
    const maxHeight = CARD_HEIGHT * 0.62
    const baseW = image.width ?? 1
    const baseH = image.height ?? 1
    const scale = Math.min(maxWidth / baseW, maxHeight / baseH, 1)

    image.set({
      left: CARD_WIDTH * 0.5,
      top: CARD_HEIGHT * 0.5,
      originX: 'center',
      originY: 'center',
      scaleX: scale,
      scaleY: scale,
    })

    setLayerMeta(image, {
      id: generateLayerId(),
      kind: 'image',
      name,
      scope: activeEditMode,
    })

    applyRuntimeConfig(image)
    canvas.add(image)
    canvas.setActiveObject(image)
    refreshLayerIndex()
    renderLayersAccordion()
    persistActiveDeckDocument()
    canvas.requestRenderAll()
  })
}

async function addGraphicReferenceLayer(name = 'Imagem'): Promise<void> {
  return withLoading(async () => {
    const svg = encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480">
        <rect x="4" y="4" width="352" height="472" rx="18" fill="#fff7e2" stroke="#b3833a" stroke-width="4" stroke-dasharray="14 10"/>
        <rect x="34" y="34" width="292" height="292" rx="16" fill="#f4e5c4" opacity="0.85"/>
        <text x="180" y="382" font-family="Arial, sans-serif" font-size="26" text-anchor="middle" fill="#7f6647">Ilustração</text>
        <text x="180" y="414" font-family="Arial, sans-serif" font-size="18" text-anchor="middle" fill="#7f6647">carregue uma imagem</text>
      </svg>
    `)
    const reference = await FabricImage.fromURL(`data:image/svg+xml;charset=utf-8,${svg}`)

    reference.set({
      left: CARD_WIDTH * 0.5,
      top: CARD_HEIGHT * 0.45,
      originX: 'center',
      originY: 'center',
      scaleX: 1,
      scaleY: 1,
    })

    setLayerMeta(reference, {
      id: generateLayerId(),
      kind: 'image',
      name,
      scope: activeEditMode,
      fit: 'fill',
      slotWidth: 360,
      slotHeight: 480,
    })

    applyRuntimeConfig(reference)
    canvas.add(reference)
    canvas.setActiveObject(reference)
    refreshLayerIndex()
    renderLayersAccordion()
    persistActiveDeckDocument()
    canvas.requestRenderAll()
  })
}

function addTextLayer(): void {
  const text = new Textbox('Texto', {
    left: CARD_WIDTH * 0.5,
    top: CARD_HEIGHT * 0.5,
    originX: 'center',
    originY: 'center',
    width: 260,
    fontFamily: 'Cinzel Decorative',
    fontSize: 44,
    fontWeight: 'bold',
    fill: '#1c2738',
    textAlign: 'center',
    lineHeight: 1.16,
  })

  setLayerMeta(text, {
    id: generateLayerId(),
    kind: 'text',
    name: `Texto ${canvas.getObjects().length}`,
    scope: activeEditMode,
  })

  applyRuntimeConfig(text)
  canvas.add(text)
  canvas.setActiveObject(text)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

const SHAPE_LABELS: Record<ShapeType, string> = {
  rect: 'Retângulo',
  rounded: 'Retângulo arredondado',
  ellipse: 'Círculo',
  triangle: 'Triângulo',
  diamond: 'Losango',
  pentagon: 'Pentágono',
  hexagon: 'Hexágono',
  star: 'Estrela',
  line: 'Linha',
}

function polygonPoints(sides: number, radius: number, innerRatio = 1): Array<{ x: number; y: number }> {
  const count = innerRatio === 1 ? sides : sides * 2
  return Array.from({ length: count }, (_, index) => {
    const r = innerRatio !== 1 && index % 2 === 1 ? radius * innerRatio : radius
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count
    return { x: r * Math.cos(angle), y: r * Math.sin(angle) }
  })
}

function createShapeObject(type: ShapeType): FabricObject {
  const common = {
    left: CARD_WIDTH * 0.5,
    top: CARD_HEIGHT * 0.5,
    originX: 'center' as const,
    originY: 'center' as const,
    fill: '#d9b36c',
    stroke: '#3b2a12',
    strokeWidth: 4,
    strokeUniform: true,
  }

  switch (type) {
    case 'rect':
      return new Rect({ ...common, width: 240, height: 160 })
    case 'rounded':
      return new Rect({ ...common, width: 240, height: 160, rx: 28, ry: 28 })
    case 'ellipse':
      return new Ellipse({ ...common, rx: 100, ry: 100 })
    case 'triangle':
      return new Triangle({ ...common, width: 220, height: 190 })
    case 'diamond':
      return new Polygon([{ x: 0, y: -120 }, { x: 80, y: 0 }, { x: 0, y: 120 }, { x: -80, y: 0 }], common)
    case 'pentagon':
      return new Polygon(polygonPoints(5, 110), common)
    case 'hexagon':
      return new Polygon(polygonPoints(6, 110), common)
    case 'star':
      return new Polygon(polygonPoints(5, 120, 0.42), common)
    case 'line':
      return new Line([0, 0, 260, 0], { ...common, fill: null, strokeWidth: 6, strokeLineCap: 'round' })
  }
}

function addShapeLayer(type: ShapeType): void {
  const shape = createShapeObject(type)
  setLayerMeta(shape, {
    id: generateLayerId(),
    kind: 'shape',
    name: `${SHAPE_LABELS[type]} ${canvas.getObjects().length}`,
    scope: activeEditMode,
  })
  applyRuntimeConfig(shape)
  canvas.add(shape)
  canvas.setActiveObject(shape)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

function createShapeControls(object: FabricObject): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const isLine = object instanceof Line

  const commit = (): void => {
    object.set('dirty', true)
    object.setCoords()
    canvas.requestRenderAll()
    persistActiveDeckDocument()
  }
  const readColor = (value: unknown, fallback: string): { hex: string; alpha: number } => {
    if (typeof value !== 'string' || !value) return { hex: fallback, alpha: 1 }
    try {
      const color = new FabricColor(value)
      return { hex: `#${color.toHex()}`, alpha: color.getAlpha() }
    } catch {
      return { hex: fallback, alpha: 1 }
    }
  }
  const composeColor = (hex: string, alpha: number): string => {
    const color = new FabricColor(hex)
    color.setAlpha(alpha)
    return color.toRgba()
  }
  const numberField = (value: number, min: number, max: number, step = 1): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(value)
    attachNoDragPropagation(input)
    return input
  }
  const colorField = (hex: string): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'color'
    input.value = hex
    attachNoDragPropagation(input)
    return input
  }
  const alphaField = (alpha: number): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'range'
    input.min = '0'
    input.max = '1'
    input.step = '0.01'
    input.value = String(alpha)
    attachNoDragPropagation(input)
    return input
  }
  const checkField = (checked: boolean): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    attachNoDragPropagation(input)
    return input
  }
  const selectField = (options: Array<[string, string]>, current: string): HTMLSelectElement => {
    const select = document.createElement('select')
    options.forEach(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      option.selected = value === current
      select.append(option)
    })
    attachNoDragPropagation(select)
    return select
  }

  const sizeW = numberField(Math.round((object.width ?? 0) * (object.scaleX ?? 1)), 1, 2000)
  sizeW.disabled = Boolean(getLayerMeta(object).locked || getLayerMeta(object).isBackground)
  sizeW.addEventListener('input', () => {
    const value = Number(sizeW.value)
    if (value >= 1 && (object.width ?? 0) > 0) {
      object.set({ scaleX: value / (object.width ?? 1) })
      commit()
    }
  })
  fragment.append(detailsRow('Largura', sizeW))

  if (!isLine) {
    const sizeH = numberField(Math.round((object.height ?? 0) * (object.scaleY ?? 1)), 1, 2000)
    sizeH.disabled = Boolean(getLayerMeta(object).locked || getLayerMeta(object).isBackground)
    sizeH.addEventListener('input', () => {
      const value = Number(sizeH.value)
      if (value >= 1 && (object.height ?? 0) > 0) {
        object.set({ scaleY: value / (object.height ?? 1) })
        commit()
      }
    })
    fragment.append(detailsRow('Altura', sizeH))
  }

  if (object instanceof Rect) {
    const maxRadius = Math.max(1, Math.floor(Math.min(object.width ?? 0, object.height ?? 0) / 2))
    const radius = numberField(Math.round(object.rx ?? 0), 0, maxRadius)
    radius.addEventListener('input', () => {
      const value = clamp(0, maxRadius, Number(radius.value) || 0)
      object.set({ rx: value, ry: value })
      commit()
    })
    fragment.append(detailsRow('Raio dos cantos', radius))
  }

  if (!isLine) {
    const fill = readColor(object.fill, '#d9b36c')
    const fillEnabled = checkField(Boolean(object.fill))
    const fillColor = colorField(fill.hex)
    const fillAlpha = alphaField(fill.alpha)
    const applyFill = (): void => {
      object.set({ fill: fillEnabled.checked ? composeColor(fillColor.value, Number(fillAlpha.value)) : null })
      commit()
    }
    fillEnabled.addEventListener('change', applyFill)
    fillColor.addEventListener('input', applyFill)
    fillAlpha.addEventListener('input', applyFill)
    fragment.append(
      detailsRow('Preenchimento', fillEnabled),
      detailsRow('Cor do preenchimento', fillColor),
      detailsRow('Opacidade do preenchimento', fillAlpha),
    )
  }

  const stroke = readColor(object.stroke, '#3b2a12')
  const currentWidth = object.strokeWidth ?? 0
  const strokeEnabled = checkField(Boolean(object.stroke) && currentWidth > 0)
  const strokeColor = colorField(stroke.hex)
  const strokeAlpha = alphaField(stroke.alpha)
  const strokeWidth = numberField(currentWidth > 0 ? currentWidth : 4, 0, 120)
  const dashArray = object.strokeDashArray
  const currentDash = !dashArray || dashArray.length === 0
    ? 'solid'
    : (dashArray[0] > currentWidth * 2 ? 'dashed' : 'dotted')
  const strokeDash = selectField([['solid', 'Sólido'], ['dashed', 'Tracejado'], ['dotted', 'Pontilhado']], currentDash)
  const strokeJoin = selectField(
    [['miter', 'Pontiagudo'], ['round', 'Arredondado'], ['bevel', 'Chanfrado']],
    object.strokeLineJoin ?? 'miter',
  )
  const strokeCap = selectField(
    [['butt', 'Reta'], ['round', 'Arredondada'], ['square', 'Quadrada']],
    object.strokeLineCap ?? 'butt',
  )
  const applyStroke = (): void => {
    const width = clamp(0, 120, Number(strokeWidth.value) || 0)
    const enabled = strokeEnabled.checked && width > 0
    const dash = strokeDash.value === 'dashed'
      ? [width * 3, width * 2]
      : strokeDash.value === 'dotted' ? [width, width * 1.6] : null
    object.set({
      stroke: enabled ? composeColor(strokeColor.value, Number(strokeAlpha.value)) : null,
      strokeWidth: enabled ? width : 0,
      strokeDashArray: dash,
      strokeLineJoin: strokeJoin.value as typeof object.strokeLineJoin,
      strokeLineCap: strokeCap.value as typeof object.strokeLineCap,
    })
    commit()
  }
  ;[strokeEnabled, strokeDash, strokeJoin, strokeCap].forEach((control) => control.addEventListener('change', applyStroke))
  ;[strokeColor, strokeAlpha, strokeWidth].forEach((control) => control.addEventListener('input', applyStroke))
  fragment.append(
    detailsRow('Contorno', strokeEnabled),
    detailsRow('Cor do contorno', strokeColor),
    detailsRow('Opacidade do contorno', strokeAlpha),
    detailsRow('Espessura do contorno', strokeWidth),
    detailsRow('Estilo do traço', strokeDash),
    detailsRow('Junção dos cantos', strokeJoin),
    detailsRow('Pontas do traço', strokeCap),
  )

  return fragment
}

function defaultAssetSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  const scale = Math.min((CARD_WIDTH * 0.5) / Math.max(1, naturalWidth), (CARD_HEIGHT * 0.5) / Math.max(1, naturalHeight), 1)
  return { width: Math.max(1, Math.round(naturalWidth * scale)), height: Math.max(1, Math.round(naturalHeight * scale)) }
}

async function fillMissingAssetSizes(deck: DeckDocument): Promise<void> {
  const pending = deck.library.filter(a => a.width <= 0 || a.height <= 0)
  if (pending.length === 0) return
  for (const asset of pending) {
    try {
      const element = await loadImageElement(asset.src)
      Object.assign(asset, defaultAssetSize(element.naturalWidth || 200, element.naturalHeight || 200))
    } catch {
      Object.assign(asset, { width: 200, height: 200 })
    }
  }
  renderLibrary()
}

function renderLibrary(): void {
  const deck = currentDeck()
  void fillMissingAssetSizes(deck)
  libraryGrid.innerHTML = ''
  libraryHint.textContent = deck.library.length === 0
    ? 'Adicione imagens ou gráficos para reutilizar no baralho.'
    : activeEditMode === 'deck'
      ? 'Clique para inserir apenas na carta atual.'
      : activeEditMode === 'back'
        ? 'Clique para inserir no verso (fixo).'
        : 'Clique para inserir no modelo (fixo: não editável nas cartas).'

  deck.library.forEach((asset) => {
    const item = document.createElement('div')
    item.className = 'library-item'

    const insertBtn = document.createElement('button')
    insertBtn.type = 'button'
    insertBtn.className = 'library-insert'
    insertBtn.title = `Inserir "${asset.name}"`
    const img = document.createElement('img')
    img.src = asset.src
    img.alt = asset.name
    insertBtn.append(img)
    insertBtn.addEventListener('click', async () => {
      await addLibraryGraphic(asset)
      assetsModal.hidden = true
    })

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'library-remove'
    removeBtn.textContent = '×'
    removeBtn.title = 'Remover da biblioteca (não afeta cartas já usadas)'
    removeBtn.setAttribute('aria-label', `Remover ${asset.name} da biblioteca`)
    removeBtn.addEventListener('click', () => {
      deck.library = deck.library.filter(a => a.id !== asset.id)
      renderLibrary()
    })

    item.append(insertBtn, removeBtn)

    const settings = document.createElement('details')
    settings.className = 'library-asset-settings'
    const settingsSummary = document.createElement('summary')
    settingsSummary.textContent = 'Ajustes'
    settings.append(settingsSummary)

    const settingsContent = document.createElement('div')
    settingsContent.className = 'library-asset-settings-content'
    const sizeRow = document.createElement('div')
    sizeRow.className = 'library-size'
    const sizeInput = (label: string, value: number, onChange: (v: number) => void): HTMLLabelElement => {
      const wrapper = document.createElement('label')
      wrapper.textContent = label
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '1'
      input.max = '4000'
      input.value = String(value)
      input.addEventListener('change', () => onChange(Math.max(1, Math.round(Number(input.value) || value))))
      wrapper.append(input)
      return wrapper
    }
    sizeRow.append(
      sizeInput('L', asset.width, (v) => { asset.width = v }),
      sizeInput('A', asset.height, (v) => { asset.height = v }),
    )
    settingsContent.append(sizeRow)

    const scaleModeLabel = document.createElement('label')
    scaleModeLabel.className = 'library-scale-mode'
    scaleModeLabel.textContent = 'Escala'
    const scaleMode = document.createElement('select')
    scaleMode.innerHTML = '<option value="stretch">Normal</option><option value="nine-slice">9 partes</option>'
    scaleMode.value = asset.scaleMode ?? 'stretch'
    scaleMode.title = 'Em 9 partes, os cantos ficam preservados e o centro é esticado.'
    scaleMode.addEventListener('change', () => {
      asset.scaleMode = scaleMode.value === 'nine-slice' ? 'nine-slice' : 'stretch'
      insets.hidden = asset.scaleMode !== 'nine-slice'
    })
    scaleModeLabel.append(scaleMode)
    settingsContent.append(scaleModeLabel)

    const insets = document.createElement('div')
    insets.className = 'library-insets'
    insets.hidden = asset.scaleMode !== 'nine-slice'
    const insetInput = (label: string, key: 'insetTop' | 'insetRight' | 'insetBottom' | 'insetLeft'): HTMLLabelElement => {
      const wrapper = document.createElement('label')
      wrapper.textContent = label
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '0'
      input.max = '4000'
      input.step = '1'
      input.value = String(asset[key] ?? 0)
      input.title = `Margem ${label.toLowerCase()} em pixels da imagem original`
      input.addEventListener('change', () => {
        asset[key] = Math.max(0, Math.round(Number(input.value) || 0))
        input.value = String(asset[key])
      })
      wrapper.append(input)
      return wrapper
    }
    insets.append(
      insetInput('Topo', 'insetTop'),
      insetInput('Dir.', 'insetRight'),
      insetInput('Base', 'insetBottom'),
      insetInput('Esq.', 'insetLeft'),
    )
    settingsContent.append(insets)
    settings.append(settingsContent)
    item.append(settings)
    libraryGrid.append(item)
  })
}

async function addLibraryGraphic(asset: LibraryAsset): Promise<void> {
  await withLoading(async () => {
    const sourceImage = await FabricImage.fromURL(asset.src)
    const imageSource = asset.scaleMode === 'nine-slice'
      ? await createNineSliceDataUrl(sourceImage, asset)
      : asset.src
    const image = imageSource === asset.src ? sourceImage : await FabricImage.fromURL(imageSource)
    const naturalSize = defaultAssetSize(image.width ?? 1, image.height ?? 1)
    const targetWidth = asset.width > 0 ? asset.width : naturalSize.width
    const targetHeight = asset.height > 0 ? asset.height : naturalSize.height
    image.set({
      left: CARD_WIDTH * 0.5,
      top: CARD_HEIGHT * 0.5,
      originX: 'center',
      originY: 'center',
      scaleX: targetWidth / Math.max(1, image.width ?? 1),
      scaleY: targetHeight / Math.max(1, image.height ?? 1),
    })
    setLayerMeta(image, {
      id: generateLayerId(),
      kind: 'graphic',
      name: asset.name,
      scope: activeEditMode,
      graphicSource: asset.src,
      scaleMode: asset.scaleMode ?? 'stretch',
      insetTop: asset.insetTop ?? 0,
      insetRight: asset.insetRight ?? 0,
      insetBottom: asset.insetBottom ?? 0,
      insetLeft: asset.insetLeft ?? 0,
    })
    applyRuntimeConfig(image)
    canvas.add(image)
    canvas.setActiveObject(image)
    refreshLayerIndex()
    renderLayersAccordion()
    persistActiveDeckDocument()
    canvas.requestRenderAll()
  })
  if (activeEditMode === 'deck') renderWorkspaceTabs()
}

async function createNineSliceDataUrl(image: FabricImage, asset: LibraryAsset): Promise<string> {
  const source = image.getElement() as HTMLImageElement
  const sourceWidth = image.width ?? source.naturalWidth
  const sourceHeight = image.height ?? source.naturalHeight
  const outputWidth = Math.max(1, Math.round(asset.width || sourceWidth))
  const outputHeight = Math.max(1, Math.round(asset.height || sourceHeight))
  const insetLeft = clamp(0, sourceWidth, asset.insetLeft ?? 0)
  const insetRight = clamp(0, sourceWidth - insetLeft, asset.insetRight ?? 0)
  const insetTop = clamp(0, sourceHeight, asset.insetTop ?? 0)
  const insetBottom = clamp(0, sourceHeight - insetTop, asset.insetBottom ?? 0)
  const fitInsets = (first: number, second: number, target: number): [number, number] => {
    const total = first + second
    return total > target && total > 0
      ? [target * first / total, target * second / total]
      : [first, second]
  }
  const [targetLeft, targetRight] = fitInsets(insetLeft, insetRight, outputWidth)
  const [targetTop, targetBottom] = fitInsets(insetTop, insetBottom, outputHeight)
  const sourceX = [0, insetLeft, sourceWidth - insetRight, sourceWidth]
  const sourceY = [0, insetTop, sourceHeight - insetBottom, sourceHeight]
  const targetX = [0, targetLeft, outputWidth - targetRight, outputWidth]
  const targetY = [0, targetTop, outputHeight - targetBottom, outputHeight]
  const output = document.createElement('canvas')
  output.width = outputWidth
  output.height = outputHeight
  const context = output.getContext('2d')
  if (!context) throw new Error('Não foi possível gerar o gráfico em nove partes.')

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const width = sourceX[column + 1] - sourceX[column]
      const height = sourceY[row + 1] - sourceY[row]
      const destinationWidth = targetX[column + 1] - targetX[column]
      const destinationHeight = targetY[row + 1] - targetY[row]
      if (width <= 0 || height <= 0 || destinationWidth <= 0 || destinationHeight <= 0) continue
      context.drawImage(
        source,
        sourceX[column], sourceY[row], width, height,
        targetX[column], targetY[row], destinationWidth, destinationHeight,
      )
    }
  }
  return output.toDataURL('image/png')
}

async function addFilesToLibrary(files: FileList): Promise<void> {
  const deck = currentDeck()
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue
    const src = await fileToObjectUrl(file)
    let size = { width: 200, height: 200 }
    try {
      const element = await loadImageElement(src)
      size = defaultAssetSize(element.naturalWidth || 200, element.naturalHeight || 200)
    } catch { /* mantém tamanho padrão */ }
    deck.library.push({ id: generateDeckId(), name: file.name.replace(/\.[^.]+$/, '') || 'Gráfico', src, ...size })
  }
  renderLibrary()
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function templateOrnament(preset: CardTemplatePreset): string {
  const accent = preset.colors[1]
  if (preset.ornament === 'leaves') return `<path d="M40 155 Q115 90 185 142 M590 155 Q515 90 445 142" fill="none" stroke="${accent}" stroke-width="8"/><path d="M86 126q-26-42-50 2q35 14 50-2m458 0q26-42 50 2q-35 14-50-2" fill="${accent}"/>`
  if (preset.ornament === 'runes') return `<g fill="none" stroke="${accent}" stroke-width="5" opacity=".9"><circle cx="74" cy="104" r="25"/><path d="m74 72 18 32-18 32-18-32zm482 0 18 32-18 32-18-32z"/></g>`
  if (preset.ornament === 'flames') return `<path d="M42 190Q18 125 77 72q-9 50 24 66 4-43 35-69 17 69-25 121zm546 0q24-65-35-118 9 50-24 66-4-43-35-69-17 69 25 121z" fill="${accent}" opacity=".78"/>`
  if (preset.ornament === 'waves') return `<path d="M30 142q45-38 90 0t90 0M420 142q45-38 90 0t90 0" fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>`
  if (preset.ornament === 'moon') return `<path d="M91 68a44 44 0 1 0 30 72 38 38 0 1 1-30-72m448 0a44 44 0 1 1-30 72 38 38 0 1 0 30-72" fill="${accent}"/>`
  return `<path d="M36 116h116M478 116h116" stroke="${accent}" stroke-width="6"/><circle cx="315" cy="70" r="9" fill="${accent}"/>`
}

function templateBaseSvg(preset: CardTemplatePreset): string {
  const [ink, accent, paper, deep] = preset.colors
  const defs = `<defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="${paper}"/><stop offset="1" stop-color="${accent}" stop-opacity=".32"/></linearGradient><linearGradient id="shade" x2="0" y2="1"><stop offset=".3" stop-color="${ink}" stop-opacity="0"/><stop offset="1" stop-color="${ink}" stop-opacity=".96"/></linearGradient><pattern id="grain" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 12h24M12 0v24" stroke="${ink}" stroke-opacity=".04"/></pattern></defs>`
  let structure = ''

  if (preset.layout === 'fullbleed') {
    structure = `<rect width="630" height="880" rx="34" fill="url(#shade)"/><rect x="13" y="13" width="604" height="854" rx="27" fill="none" stroke="${accent}" stroke-width="7"/><path d="M30 30h570v128H30z" fill="${ink}" fill-opacity=".72"/><path d="M30 620h570v230H30z" fill="${ink}" fill-opacity=".82"/><path d="M48 686h430" stroke="${accent}" stroke-width="3"/><circle cx="548" cy="795" r="48" fill="${ink}" stroke="${accent}" stroke-width="6"/>${templateOrnament(preset)}`
  } else if (preset.layout === 'splitLeft') {
    structure = `<rect width="630" height="880" rx="34" fill="${ink}"/><rect x="14" y="14" width="602" height="852" rx="26" fill="${paper}" stroke="${accent}" stroke-width="5"/><rect x="28" y="28" width="276" height="824" rx="18" fill="${deep}"/><path d="M318 28h284v824H318z" fill="url(#grain)"/><path d="M318 188h284" stroke="${accent}" stroke-width="5"/><path d="M318 646h284" stroke="${deep}" stroke-width="2"/><circle cx="551" cy="794" r="42" fill="${ink}" stroke="${accent}" stroke-width="5"/>`
  } else if (preset.layout === 'splitRight') {
    structure = `<rect width="630" height="880" rx="34" fill="${ink}"/><rect x="14" y="14" width="602" height="852" rx="26" fill="${paper}" stroke="${accent}" stroke-width="5"/><rect x="326" y="28" width="276" height="824" rx="18" fill="${deep}"/><path d="M28 28h284v824H28z" fill="url(#grain)"/><path d="M28 188h284" stroke="${accent}" stroke-width="5"/><path d="M28 646h284" stroke="${deep}" stroke-width="2"/><circle cx="82" cy="794" r="42" fill="${ink}" stroke="${accent}" stroke-width="5"/>`
  } else if (preset.layout === 'landscape') {
    structure = `<rect width="630" height="880" rx="34" fill="${ink}"/><rect x="14" y="14" width="602" height="852" rx="26" fill="url(#bg)" stroke="${accent}" stroke-width="5"/><path d="M34 34h562v108H34z" fill="${ink}"/><rect x="34" y="158" width="562" height="400" rx="8" fill="${deep}" stroke="${accent}" stroke-width="5"/><path d="M34 576h562v260H34z" fill="${paper}" stroke="${deep}" stroke-width="3"/><path d="M34 576h562v52H34z" fill="${deep}"/><path d="M500 628v208" stroke="${accent}" stroke-width="3"/>`
  } else if (preset.layout === 'poster') {
    structure = `<rect width="630" height="880" rx="34" fill="${paper}"/><rect x="14" y="14" width="602" height="852" rx="25" fill="none" stroke="${ink}" stroke-width="12"/><path d="M34 34h562v116H34z" fill="${paper}" fill-opacity=".94"/><rect x="46" y="166" width="538" height="548" fill="${deep}" stroke="${accent}" stroke-width="4"/><path d="M46 730h538v116H46z" fill="${ink}"/><rect x="46" y="714" width="538" height="16" fill="${accent}"/>`
  } else {
    structure = `<rect width="630" height="880" rx="34" fill="${ink}"/><rect x="13" y="13" width="604" height="854" rx="27" fill="url(#bg)" stroke="${accent}" stroke-width="5"/><rect x="26" y="26" width="578" height="828" rx="21" fill="url(#grain)" stroke="${deep}" stroke-width="3"/><path d="M39 36h552v115H39z" fill="${ink}" opacity=".96"/><rect x="48" y="169" width="534" height="390" rx="16" fill="${deep}" stroke="${accent}" stroke-width="8"/><path d="M48 585h534v202c0 19-15 34-34 34H82c-19 0-34-15-34-34z" fill="${paper}" stroke="${deep}" stroke-width="4"/><path d="M48 585h534v54H48z" fill="${deep}"/><circle cx="546" cy="818" r="45" fill="${ink}" stroke="${accent}" stroke-width="6"/><circle cx="84" cy="818" r="18" fill="${accent}"/><circle cx="121" cy="818" r="8" fill="${deep}" opacity=".65"/>${templateOrnament(preset)}`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="630" height="880" viewBox="0 0 630 880">
    ${defs}${structure}
  </svg>`
}

function templateIllustrationSvg(preset: CardTemplatePreset, width: number, height: number): string {
  const [ink, accent, paper, deep] = preset.colors
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 500 700" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="${deep}"/><stop offset="1" stop-color="${ink}"/></linearGradient></defs>
    <rect width="500" height="700" fill="url(#sky)"/>
    <circle cx="368" cy="178" r="92" fill="${accent}" opacity=".5"/>
    <path d="M0 580 112 350l76 116 75-211 77 182 54-94 106 237v120H0z" fill="${paper}" opacity=".2"/>
    <path d="M0 620 126 435l74 104 93-168 74 128 54-76 79 135v142H0z" fill="${accent}" opacity=".48"/>
    <g fill="${paper}" opacity=".9" text-anchor="middle" font-family="Arial, sans-serif"><text x="250" y="315" font-size="38" font-weight="700">SUA ARTE</text><text x="250" y="353" font-size="19">duplo clique para substituir</text></g>
  </svg>`
}

interface TemplateLayoutSpec {
  art: { left: number; top: number; width: number; height: number }
  baseAboveArt?: boolean
  title: ConstructorParameters<typeof Textbox>[1]
  typeLine: ConstructorParameters<typeof Textbox>[1]
  rules: ConstructorParameters<typeof Textbox>[1]
  stats: ConstructorParameters<typeof Textbox>[1]
}

function templateLayoutSpec(preset: CardTemplatePreset): TemplateLayoutSpec {
  const [ink, , paper, deep] = preset.colors
  const aligned = { originX: 'left' as const, originY: 'top' as const }
  const centered = { originX: 'center' as const, originY: 'center' as const }

  if (preset.layout === 'fullbleed') return {
    art: { left: 0, top: 0, width: 630, height: 880 }, baseAboveArt: true,
    title: { ...aligned, left: 52, top: 62, width: 526, fontSize: 34, fill: paper, textAlign: 'left' },
    typeLine: { ...aligned, left: 50, top: 642, width: 430, fontSize: 19, fill: paper, textAlign: 'left' },
    rules: { ...aligned, left: 50, top: 704, width: 430, fontSize: 22, fill: paper, textAlign: 'left' },
    stats: { ...centered, left: 548, top: 795, width: 80, fontSize: 21, fill: paper, textAlign: 'center' },
  }
  if (preset.layout === 'splitLeft') return {
    art: { left: 38, top: 38, width: 256, height: 804 },
    title: { ...aligned, left: 338, top: 64, width: 238, fontSize: 29, fill: ink, textAlign: 'left' },
    typeLine: { ...aligned, left: 338, top: 210, width: 238, fontSize: 17, fill: deep, textAlign: 'left' },
    rules: { ...aligned, left: 338, top: 278, width: 232, fontSize: 23, fill: ink, textAlign: 'left' },
    stats: { ...centered, left: 551, top: 794, width: 74, fontSize: 20, fill: paper, textAlign: 'center' },
  }
  if (preset.layout === 'splitRight') return {
    art: { left: 336, top: 38, width: 256, height: 804 },
    title: { ...aligned, left: 52, top: 64, width: 238, fontSize: 29, fill: ink, textAlign: 'left' },
    typeLine: { ...aligned, left: 52, top: 210, width: 238, fontSize: 17, fill: deep, textAlign: 'left' },
    rules: { ...aligned, left: 52, top: 278, width: 232, fontSize: 23, fill: ink, textAlign: 'left' },
    stats: { ...centered, left: 82, top: 794, width: 74, fontSize: 20, fill: paper, textAlign: 'center' },
  }
  if (preset.layout === 'landscape') return {
    art: { left: 44, top: 168, width: 542, height: 380 },
    title: { ...centered, left: 315, top: 86, width: 500, fontSize: 31, fill: paper, textAlign: 'center' },
    typeLine: { ...aligned, left: 55, top: 590, width: 430, fontSize: 18, fill: paper, textAlign: 'left' },
    rules: { ...aligned, left: 58, top: 660, width: 416, fontSize: 22, fill: ink, textAlign: 'left' },
    stats: { ...centered, left: 548, top: 732, width: 74, fontSize: 22, fill: deep, textAlign: 'center' },
  }
  if (preset.layout === 'poster') return {
    art: { left: 56, top: 176, width: 518, height: 528 },
    title: { ...centered, left: 315, top: 90, width: 520, fontSize: 34, fill: ink, textAlign: 'center' },
    typeLine: { ...aligned, left: 64, top: 750, width: 300, fontSize: 17, fill: paper, textAlign: 'left' },
    rules: { ...aligned, left: 64, top: 790, width: 400, fontSize: 17, fill: paper, textAlign: 'left' },
    stats: { ...centered, left: 536, top: 790, width: 82, fontSize: 22, fill: paper, textAlign: 'center' },
  }
  return {
    art: { left: 65, top: 186, width: 500, height: 356 },
    title: { ...centered, left: 315, top: 92, width: 450, fontSize: 30, fill: paper, textAlign: 'center' },
    typeLine: { ...aligned, left: 72, top: 600, width: 456, fontSize: 18, fill: paper, textAlign: 'left' },
    rules: { ...aligned, left: 78, top: 668, width: 444, fontSize: 22, fill: ink, textAlign: 'left' },
    stats: { ...centered, left: 546, top: 818, width: 76, fontSize: 21, fill: paper, textAlign: 'center' },
  }
}

function createTemplateText(text: string, name: string, options: ConstructorParameters<typeof Textbox>[1]): Textbox {
  const object = new Textbox(text, options)
  setLayerMeta(object, { id: generateLayerId(), kind: 'text', name, scope: 'model' })
  applyRuntimeConfig(object)
  return object
}

async function applyCardTemplate(preset: CardTemplatePreset): Promise<void> {
  persistActiveDeckDocument()
  const deck = currentDeck()
  if (activeEditMode !== 'model') {
    deck.activeModelId = modelOfCard(deck, deck.cards.find(c => c.id === deck.activeCardId)).id
  }
  activeEditMode = 'model'
  activeRightPanelTab = 'model-layers'
  destroySelectedTextEditor()
  canvas.clear()
  layerById.clear()

  await withLoading(async () => {
    const layout = templateLayoutSpec(preset)
    const base = await FabricImage.fromURL(svgDataUrl(templateBaseSvg(preset)))
    base.set({ left: 0, top: 0, originX: 'left', originY: 'top' })
    setLayerMeta(base, { id: generateLayerId(), kind: 'image', name: `Base • ${preset.name}`, scope: 'model', isBackground: true })
    applyRuntimeConfig(base)

    const illustration = await FabricImage.fromURL(svgDataUrl(templateIllustrationSvg(preset, layout.art.width, layout.art.height)))
    illustration.set({ left: layout.art.left, top: layout.art.top, originX: 'left', originY: 'top' })
    setLayerMeta(illustration, { id: generateLayerId(), kind: 'image', name: 'Ilustração', scope: 'model', fit: 'cover', slotWidth: layout.art.width, slotHeight: layout.art.height })
    applyRuntimeConfig(illustration)

    if (layout.baseAboveArt) canvas.add(illustration, base)
    else canvas.add(base, illustration)

    const title = createTemplateText(preset.title, 'Nome da carta', { fontFamily: 'Cinzel Decorative', fontWeight: 'bold', lineHeight: 1.05, ...layout.title })
    const typeLine = createTemplateText(preset.typeLine, 'Tipo da carta', { fontFamily: 'Cinzel Decorative', fontWeight: 'bold', lineHeight: 1.05, ...layout.typeLine })
    const rules = createTemplateText(preset.rules, 'Texto de regras', { fontFamily: 'Arial', lineHeight: 1.22, ...layout.rules })
    const stats = createTemplateText(preset.stats, 'Atributos', { fontFamily: 'Cinzel Decorative', fontWeight: 'bold', lineHeight: 1, ...layout.stats })
    canvas.add(title, typeLine, rules, stats)

    const targetModel = activeModelOf(deck)
    targetModel.canvas = canvas.toObject(['data'])
    deck.cards.forEach((card) => {
      if (card.modelId !== targetModel.id) return
      card.modelOverrides = {}
      card.thumbnail = ''
    })
    refreshLayerIndex()
    canvas.discardActiveObject()
    canvas.requestRenderAll()
    renderWorkspaceTabs()
    await refreshDeckThumbnails(deck)
  })
}

function renderTemplateGallery(isNewModel = false): void {
  templatesGrid.innerHTML = ''
  const blank = document.createElement('article')
  blank.className = 'template-card'
  blank.style.cursor = 'pointer'
  blank.style.setProperty('--template-ink', '#64748b')
  blank.style.setProperty('--template-accent', '#94a3b8')
  blank.style.setProperty('--template-paper', '#ffffff')
  blank.style.setProperty('--template-deep', '#334155')
  blank.innerHTML = '<div class="template-card-preview" style="display:grid;place-items:center"><span class="material-symbols-outlined" style="font-size:56px;opacity:.5">crop_portrait</span></div><div class="template-card-content"><span class="template-family">Do zero</span><h3>Modelo limpo</h3><p>Começar com a carta vazia, sem nenhum elemento.</p><button class="primary template-apply" type="button">Usar modelo limpo</button></div>'
  blank.addEventListener('click', async () => {
    if (isNewModel) {
      templatesModal.hidden = true
      return
    }
    const deck = currentDeck()
    const hasModel = activeEditMode === 'model'
      ? canvas.getObjects().length > 0
      : ((modelOfCard(deck, deck.cards.find(c => c.id === deck.activeCardId)).canvas.objects ?? []) as unknown[]).length > 0
    if (hasModel && !window.confirm('Usar o modelo limpo apagará o layout atual da frente. Continuar?')) return
    templatesModal.hidden = true
    persistActiveDeckDocument()
    if (activeEditMode !== 'model') {
      deck.activeModelId = modelOfCard(deck, deck.cards.find(c => c.id === deck.activeCardId)).id
    }
    activeEditMode = 'model'
    activeRightPanelTab = 'model-layers'
    destroySelectedTextEditor()
    const targetModel = activeModelOf(deck)
    targetModel.canvas = createEmptyCanvasState()
    deck.cards.forEach((card) => {
      if (card.modelId !== targetModel.id) return
      card.modelOverrides = {}
      card.thumbnail = ''
    })
    await loadActiveModelIntoEditor()
    renderWorkspaceTabs()
    await refreshDeckThumbnails(deck)
  })
  templatesGrid.append(blank)
  CARD_TEMPLATE_PRESETS.forEach((preset) => {
    const card = document.createElement('article')
    card.className = 'template-card'
    card.style.cursor = 'pointer'
    card.style.setProperty('--template-ink', preset.colors[0])
    card.style.setProperty('--template-accent', preset.colors[1])
    card.style.setProperty('--template-paper', preset.colors[2])
    card.style.setProperty('--template-deep', preset.colors[3])
    card.innerHTML = `<div class="template-card-preview layout-${preset.layout}"><div class="template-preview-title">${preset.title}</div><div class="template-preview-art"><span class="material-symbols-outlined">image</span></div><div class="template-preview-type">${preset.typeLine}</div><div class="template-preview-copy">Texto de regras e habilidades da carta.</div><div class="template-preview-stat">${preset.stats}</div></div><div class="template-card-content"><span class="template-family">${preset.family}</span><h3>${preset.name}</h3><p>${preset.description}</p><button class="primary template-apply" type="button">Usar este modelo</button></div>`
    card.addEventListener('click', async () => {
      const deck = currentDeck()
      const hasModel = activeEditMode === 'model'
        ? canvas.getObjects().length > 0
        : ((modelOfCard(deck, deck.cards.find(c => c.id === deck.activeCardId)).canvas.objects ?? []) as unknown[]).length > 0
      if (hasModel && !window.confirm('Aplicar este modelo substituirá o layout atual da frente. Continuar?')) return
      templatesModal.hidden = true
      try {
        await applyCardTemplate(preset)
      } catch {
        window.alert('Não foi possível aplicar o modelo selecionado.')
      }
    })
    templatesGrid.append(card)
  })
}

function createCard(modelId: string, backId: string): void {
  persistActiveDeckDocument()
  const deck = currentDeck()
  const model = deck.models.find((item) => item.id === modelId) ?? activeModelOf(deck)
  const newCard: CardState = {
    id: generateDeckId(),
    name: `Carta ${deck.cards.length + 1}`,
    canvas: createCardCanvasFromModel(model),
    deckObjects: [],
    modelId,
    backId,
    modelOverrides: {},
    thumbnail: '',
  }
  deck.cards.push(newCard)
  deck.activeCardId = newCard.id
  void loadActiveDeckCard(deck, newCard.id).then(async () => {
    await refreshDeckThumbnails(deck)
  })
  renderWorkspaceTabs()
}

interface ConfirmChoice {
  label: string
  options: Array<{ value: string; label: string; acceptLabel?: string }>
}

function openConfirm(
  title: string,
  message: string,
  acceptLabel: string,
  choice?: ConfirmChoice,
): Promise<{ ok: boolean; choice: string }> {
  return new Promise((resolve) => {
    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalAccept.textContent = acceptLabel
    confirmModalChoiceWrap.hidden = !choice
    confirmModalChoice.innerHTML = ''
    if (choice) {
      confirmModalChoiceLabel.textContent = choice.label
      choice.options.forEach((item) => {
        const option = document.createElement('option')
        option.value = item.value
        option.textContent = item.label
        confirmModalChoice.append(option)
      })
    }
    const syncAcceptLabel = (): void => {
      const selected = choice?.options.find(o => o.value === confirmModalChoice.value)
      confirmModalAccept.textContent = selected?.acceptLabel ?? acceptLabel
    }
    syncAcceptLabel()
    confirmModal.hidden = false
    confirmModalAccept.focus()

    const finish = (ok: boolean): void => {
      confirmModal.hidden = true
      confirmModalAccept.removeEventListener('click', onAccept)
      confirmModalCancel.removeEventListener('click', onCancel)
      confirmModalBackdrop.removeEventListener('click', onCancel)
      confirmModalChoice.removeEventListener('change', syncAcceptLabel)
      window.removeEventListener('keydown', onKey)
      resolve({ ok, choice: confirmModalChoice.value })
    }
    const onAccept = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(false)
    }
    confirmModalAccept.addEventListener('click', onAccept)
    confirmModalCancel.addEventListener('click', onCancel)
    confirmModalBackdrop.addEventListener('click', onCancel)
    confirmModalChoice.addEventListener('change', syncAcceptLabel)
    window.addEventListener('keydown', onKey)
  })
}

function pickLibraryAsset(): Promise<LibraryAsset | null> {
  return new Promise((resolve) => {
    const assets = currentDeck().library
    let selected: LibraryAsset | null = null
    assetPickerList.innerHTML = ''
    assetPickerConfirm.disabled = true
    if (assets.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'layer-note'
      empty.textContent = 'Nenhum asset disponível na biblioteca.'
      assetPickerList.append(empty)
    }
    const buttons: HTMLButtonElement[] = []
    const finish = (asset: LibraryAsset | null): void => {
      assetPickerModal.hidden = true
      assetPickerConfirm.removeEventListener('click', onConfirm)
      assetPickerCancel.removeEventListener('click', onCancel)
      assetPickerBackdrop.removeEventListener('click', onCancel)
      window.removeEventListener('keydown', onKey)
      resolve(asset)
    }
    const onConfirm = (): void => finish(selected)
    const onCancel = (): void => finish(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(null)
    }
    assets.forEach((asset) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'variant-option asset-picker-item'
      const img = document.createElement('img')
      img.src = asset.src
      img.alt = asset.name
      const label = document.createElement('span')
      label.textContent = asset.name
      button.append(img, label)
      button.addEventListener('click', () => {
        selected = asset
        buttons.forEach((item) => item.classList.toggle('is-active', item === button))
        assetPickerConfirm.disabled = false
      })
      button.addEventListener('dblclick', () => finish(asset))
      buttons.push(button)
      assetPickerList.append(button)
    })
    assetPickerConfirm.addEventListener('click', onConfirm)
    assetPickerCancel.addEventListener('click', onCancel)
    assetPickerBackdrop.addEventListener('click', onCancel)
    window.addEventListener('keydown', onKey)
    assetPickerModal.hidden = false
    assetPickerCancel.focus()
  })
}

async function confirmDialog(title: string, message: string, acceptLabel: string): Promise<boolean> {
  return (await openConfirm(title, message, acceptLabel)).ok
}

function variantList(): Array<CardModel | CardBack> {
  const deck = currentDeck()
  return activeEditMode === 'back' ? deck.backs : deck.models
}

function renderVariantBar(): void {
  const deck = currentDeck()
  const isBack = activeEditMode === 'back'
  const items = variantList()
  const activeId = isBack ? deck.activeBackId : deck.activeModelId
  layersSectionTitle.textContent = isBack ? 'Verso' : 'Modelo'
  variantSelect.innerHTML = ''
  items.forEach((item) => {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.name
    option.selected = item.id === activeId
    variantSelect.append(option)
  })
  variantDeleteButton.disabled = items.length <= 1
  variantNameInput.value = items.find(item => item.id === activeId)?.name ?? ''
  variantNameInput.placeholder = isBack ? 'Nome do verso' : 'Nome do modelo'
  variantNewButton.title = isBack ? 'Criar um novo verso' : 'Criar um novo modelo'
}

async function switchVariant(id: string): Promise<void> {
  const deck = currentDeck()
  persistActiveDeckDocument()
  if (activeEditMode === 'back') {
    deck.activeBackId = id
    destroySelectedTextEditor()
    await loadDeckCanvas(activeBackOf(deck).canvas)
  } else {
    deck.activeModelId = id
    destroySelectedTextEditor()
    await loadActiveModelIntoEditor()
  }
  renderWorkspaceTabs()
}

async function addVariant(): Promise<void> {
  const deck = currentDeck()
  persistActiveDeckDocument()
  if (activeEditMode === 'back') {
    const back: CardBack = { id: generateDeckId(), name: `Verso ${deck.backs.length + 1}`, canvas: createEmptyCanvasState(), thumbnail: '' }
    deck.backs.push(back)
    await switchVariant(back.id)
    return
  }
  const model: CardModel = { id: generateDeckId(), name: `Modelo ${deck.models.length + 1}`, canvas: createEmptyCanvasState() }
  deck.models.push(model)
  await switchVariant(model.id)
  renderTemplateGallery(true)
  templatesModal.hidden = false
}

async function duplicateVariant(): Promise<void> {
  const deck = currentDeck()
  persistActiveDeckDocument()
  if (activeEditMode === 'back') {
    const source = activeBackOf(deck)
    const copy: CardBack = { ...source, id: generateDeckId(), name: `${source.name} - cópia`, canvas: cloneCanvasState(source.canvas) }
    deck.backs.push(copy)
    await switchVariant(copy.id)
    return
  }
  const source = activeModelOf(deck)
  const copy: CardModel = { id: generateDeckId(), name: `${source.name} - cópia`, canvas: cloneCanvasState(source.canvas) }
  deck.models.push(copy)
  await switchVariant(copy.id)
}

function renameVariant(): void {
  const deck = currentDeck()
  const item = activeEditMode === 'back' ? activeBackOf(deck) : activeModelOf(deck)
  const next = variantNameInput.value.trim()
  if (!next) return
  item.name = next
  const option = Array.from(variantSelect.options).find(o => o.value === item.id)
  if (option) option.textContent = next
}

async function deleteVariant(): Promise<void> {
  const deck = currentDeck()
  persistActiveDeckDocument()

  if (activeEditMode === 'back') {
    if (deck.backs.length <= 1) return
    const target = activeBackOf(deck)
    const affected = deck.cards.filter(c => c.backId === target.id).length
    const others = deck.backs.filter(b => b.id !== target.id)
    const result = await openConfirm(
      'Excluir verso',
      affected > 0
        ? `O verso "${target.name}" será excluído. Escolha qual verso as ${affected} carta(s) que o usavam passarão a usar.`
        : `O verso "${target.name}" será excluído.`,
      'Excluir verso',
      affected > 0
        ? { label: 'Mudar cartas para', options: others.map(b => ({ value: b.id, label: b.name })) }
        : undefined,
    )
    if (!result.ok) return
    deck.backs = deck.backs.filter(b => b.id !== target.id)
    const fallback = deck.backs.find(b => b.id === result.choice) ?? deck.backs[0]
    deck.cards.forEach((card) => { if (card.backId === target.id) card.backId = fallback.id })
    await switchVariant(fallback.id)
    return
  }

  if (deck.models.length <= 1) return
  const target = activeModelOf(deck)
  const affected = deck.cards.filter(c => c.modelId === target.id).length
  const result = await openConfirm(
    'Excluir modelo',
    affected > 0
      ? `O modelo "${target.name}" será excluído. As ${affected} carta(s) criadas a partir dele manterão seus layers independentes.`
      : `O modelo "${target.name}" será excluído. Esta ação não pode ser desfeita.`,
    'Excluir modelo',
  )
  if (!result.ok) return

  deck.models = deck.models.filter(m => m.id !== target.id)
  const fallback = deck.models[0]
  deck.cards.forEach((card) => { if (card.modelId === target.id) card.modelId = fallback.id })
  if (!deck.cards.some(c => c.id === deck.activeCardId)) deck.activeCardId = deck.cards[0].id
  deck.activeModelId = fallback.id
  destroySelectedTextEditor()
  await loadActiveModelIntoEditor()
  await refreshDeckThumbnails(deck)
  renderWorkspaceTabs()
}

function renderCardVariantControls(): void {
  const deck = currentDeck()
  const card = deck.cards.find(c => c.id === deck.activeCardId)
  const fill = (select: HTMLSelectElement, items: Array<CardModel | CardBack>, current: string): void => {
    select.innerHTML = ''
    items.forEach((item) => {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = item.name
      option.selected = item.id === current
      select.append(option)
    })
  }
  fill(cardModelSelect, deck.models, card?.modelId ?? '')
  fill(cardBackSelect, deck.backs, card?.backId ?? '')
}

async function changeActiveCardModel(modelId: string): Promise<void> {
  const deck = currentDeck()
  const card = deck.cards.find(c => c.id === deck.activeCardId)
  const next = deck.models.find(m => m.id === modelId)
  if (!card || !next || card.modelId === modelId) return

  const ok = await confirmDialog(
    'Recriar carta a partir do modelo',
    `Os layers atuais de "${card.name}" serão substituídos por uma cópia independente do modelo "${next.name}".`,
    'Recriar carta',
  )
  if (!ok) {
    renderCardVariantControls()
    return
  }
  persistActiveDeckDocument()
  card.modelId = modelId
  card.canvas = createCardCanvasFromModel(next)
  card.deckObjects = []
  card.modelOverrides = {}
  deck.activeModelId = modelId
  await loadActiveDeckCard(deck, card.id)
  await refreshDeckThumbnails(deck)
  renderWorkspaceTabs()
}

function changeActiveCardBack(backId: string): void {
  const deck = currentDeck()
  const card = deck.cards.find(c => c.id === deck.activeCardId)
  if (!card || card.backId === backId) return
  card.backId = backId
  renderWorkspaceTabs()
}

async function addNewCard(): Promise<void> {
  persistActiveDeckDocument()
  const deck = currentDeck()
  const activeCard = deck.cards.find(c => c.id === deck.activeCardId)
  if (deck.models.length === 1 && deck.backs.length === 1) {
    createCard(deck.models[0].id, deck.backs[0].id)
    return
  }

  let selectedModelId = modelOfCard(deck, activeCard).id
  let selectedBackId = backOfCard(deck, activeCard).id
  const modelThumbs = new Map<string, string>()
  await withLoading(async () => {
    for (const model of deck.models) {
      try {
        modelThumbs.set(model.id, await captureModelThumbnail(model))
      } catch {
        modelThumbs.set(model.id, '')
      }
    }
  })

  const renderPicker = (
    host: HTMLElement,
    items: Array<CardModel | CardBack>,
    thumb: (item: CardModel | CardBack) => string,
    getSelected: () => string,
    select: (id: string) => void,
  ): void => {
    host.innerHTML = ''
    items.forEach((item) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `variant-option ${item.id === getSelected() ? 'is-active' : ''}`
      const src = thumb(item)
      if (src) {
        const img = document.createElement('img')
        img.src = src
        img.alt = item.name
        button.append(img)
      }
      const label = document.createElement('span')
      label.textContent = item.name
      button.append(label)
      button.addEventListener('click', () => {
        select(item.id)
        renderAll()
      })
      host.append(button)
    })
  }
  const renderAll = (): void => {
    renderPicker(newCardModels, deck.models, m => modelThumbs.get(m.id) ?? '', () => selectedModelId, (id) => { selectedModelId = id })
    renderPicker(newCardBacks, deck.backs, b => (b as CardBack).thumbnail, () => selectedBackId, (id) => { selectedBackId = id })
  }
  renderAll()
  newCardModal.hidden = false

  const close = (): void => {
    newCardModal.hidden = true
    newCardCreate.removeEventListener('click', onCreate)
    newCardCancel.removeEventListener('click', close)
    newCardModalBackdrop.removeEventListener('click', close)
  }
  const onCreate = (): void => {
    close()
    createCard(selectedModelId, selectedBackId)
  }
  newCardCreate.addEventListener('click', onCreate)
  newCardCancel.addEventListener('click', close)
  newCardModalBackdrop.addEventListener('click', close)
}

function selectCard(cardId: string): void {
  const deck = currentDeck()
  if (cardId === deck.activeCardId) return
  persistActiveDeckDocument()
  deck.activeCardId = cardId
  void loadActiveDeckCard(deck, cardId)
  renderCardThumbnails()
}

function deckAutosaveSnapshot(): unknown {
  persistActiveDeckDocument()
  const deck = currentDeck()
  return stripImagePayloads({
    version: 1,
    deck: {
      id: deck.id,
      name: deck.name,
      models: deck.models.map(model => ({ id: model.id, name: model.name, canvas: model.canvas })),
      backs: deck.backs.map(back => ({ id: back.id, name: back.name, canvas: back.canvas, thumbnail: back.thumbnail })),
      library: deck.library,
      activeModelId: deck.activeModelId,
      activeBackId: deck.activeBackId,
      cards: deck.cards,
      activeCardId: deck.activeCardId,
      cover: deck.cover ?? '',
    },
  })
}

let autosaveRunning = false

async function runLightweightAutosave(): Promise<void> {
  if (autosaveRunning) return
  autosaveRunning = true
  try {
    await saveLightweightAutosave(deckAutosaveSnapshot(), {
      key: history.key,
      index: history.index,
      count: history.stack.length,
    })
  } catch (error) {
    console.warn('Falha no autosave local do projeto.', error)
  } finally {
    autosaveRunning = false
  }
}

async function runCompleteAutosave(): Promise<void> {
  if (autosaveRunning || !activeDeckFileHandle || !(await activeDeckPermissionGranted())) return
  autosaveRunning = true
  try {
    const blob = await createDeckArchive(deckFileSnapshot())
    await writeActiveDeckFile(blob)
  } catch (error) {
    console.warn('Falha no autosave completo do projeto.', error)
  } finally {
    autosaveRunning = false
  }
}

window.setInterval(() => { void runLightweightAutosave() }, 30_000)
window.setInterval(() => { void runCompleteAutosave() }, 5 * 60_000)

async function saveActiveDeckAsFile(): Promise<void> {
  try {
    syncDeckFilename()
    const filename = `${currentDeck().name || DEFAULT_DECK_NAME}.deck`
    const selection = activeDeckFileHandle ? 'selected' : await selecionarLocalArquivo(filename)
    if (selection === 'cancelled') return

    await withLoading(async () => {
      const blob = await createDeckArchive(deckFileSnapshot())
      if (selection === 'unsupported' || !(await writeActiveDeckFile(blob))) {
        downloadBlob(filename, blob)
      }
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      clearActiveDeckFileHandle()
    }
    window.alert(error instanceof Error ? error.message : 'Falha ao salvar baralho.')
  }
}

async function importDeckFile(file: File): Promise<void> {
  return withLoading(async () => {
    const archived = await readDeckArchive(file)
    const parsed = (archived ?? JSON.parse(await decompressDeckText(file))) as Record<string, unknown>

    let rawDeck: Record<string, unknown> | null = null

    if (parsed['version'] === 1 && parsed['deck']) {
      rawDeck = { ...(parsed['deck'] as Record<string, unknown>) }
      if (typeof rawDeck['cover'] !== 'string' && typeof parsed['cover'] === 'string') rawDeck['cover'] = parsed['cover']
      if (!rawDeck['name']) rawDeck['name'] = file.name.replace(/\.deck$/i, '') || DEFAULT_DECK_NAME
    } else if (parsed['canvas'] || parsed['modelCanvas']) {
      rawDeck = { ...parsed }
      if (!rawDeck['name']) rawDeck['name'] = file.name.replace(/\.deck$/i, '') || DEFAULT_DECK_NAME
    }

    if (!rawDeck) throw new Error('Arquivo .deck inválido.')

    const deck = migrateDeckDocument({
      ...rawDeck,
      id: generateDeckId(),
      name: file.name.replace(/\.[^.]+$/, '') || DEFAULT_DECK_NAME,
    })
    deckDocuments = [deck]
    activeDeckId = deck.id
    coverMode = 'blur'
    activeEditMode = 'deck'
    await loadActiveDeckCard(deck)
    await refreshDeckThumbnails(deck)
    renderWorkspaceSidebar()
  })
}

async function exportCanvasPng(): Promise<void> {
  return withLoading(async () => {
    const imageData = canvas.toDataURL({
      format: 'png',
      multiplier: 2,
    })

    const anchor = document.createElement('a')
    anchor.href = imageData
    anchor.download = `${buildExportFilename()}.png`
    anchor.click()
  })
}

function presetByKey(list: SizePreset[], key: string): SizePreset | null {
  return list.find((item) => item.key === key) ?? null
}

function mmToPx(mm: number, dpi = 300): number {
  return Math.max(1, Math.round((mm / 25.4) * dpi))
}

function canvasToBlob(canvasElement: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvasElement.toBlob((blob) => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('Falha ao gerar imagem para impressao.'))
      }
    }, type)
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Falha ao carregar imagem da carta.'))
    image.src = src
  })
}

function currentPrintCardSize(): { widthMm: number; heightMm: number } {
  if (printCardSizeSelect.value === 'custom') {
    const widthMm = clamp(10, 300, Number(printCardWidthInput.value) || 63)
    const heightMm = clamp(10, 300, Number(printCardHeightInput.value) || 88)
    return { widthMm, heightMm }
  }

  const preset = presetByKey(CARD_SIZE_PRESETS, printCardSizeSelect.value) ?? CARD_SIZE_PRESETS[0]
  return { widthMm: preset.widthMm, heightMm: preset.heightMm }
}

function currentPrintPaperSize(): { widthMm: number; heightMm: number } {
  const preset = presetByKey(PAPER_SIZE_PRESETS, printPaperSizeSelect.value) ?? PAPER_SIZE_PRESETS[0]
  const portraitWidth = Math.min(preset.widthMm, preset.heightMm)
  const portraitHeight = Math.max(preset.widthMm, preset.heightMm)

  if (printOrientationSelect.value === 'landscape') {
    return { widthMm: portraitHeight, heightMm: portraitWidth }
  }

  return { widthMm: portraitWidth, heightMm: portraitHeight }
}

function currentPrintLayout(): {
  card: { widthMm: number; heightMm: number }
  paper: { widthMm: number; heightMm: number }
  gapMm: number
  sideMarginMm: number
  columns: number
  rows: number
  perSheet: number
} {
  const card = currentPrintCardSize()
  const paper = currentPrintPaperSize()
  const gapMm = clamp(0, 30, Number(printGapInput.value) || 0)
  const sideMarginMm = 6

  const usableWidthMm = Math.max(1, paper.widthMm - sideMarginMm * 2)
  const usableHeightMm = Math.max(1, paper.heightMm - sideMarginMm * 2)
  const columns = Math.max(1, Math.floor((usableWidthMm + gapMm) / (card.widthMm + gapMm)))
  const rows = Math.max(1, Math.floor((usableHeightMm + gapMm) / (card.heightMm + gapMm)))

  return {
    card,
    paper,
    gapMm,
    sideMarginMm,
    columns,
    rows,
    perSheet: Math.max(1, columns * rows),
  }
}

async function captureDeckCardPrintImage(deck: DeckDocument, cardId: string): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(buildCardCanvasState(deck, cardId))
  applyDeckModelImageFit(thumbnailCanvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'png', multiplier: 1 })
}

async function captureDeckBackPrintImage(back: CardBack): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(back.canvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'png', multiplier: 1 })
}

function drawCutGuide(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  const lineWidth = Math.max(1, mmToPx(clamp(0.1, 2, Number(printCutLineWidth.value) || 0.2)))
  const style = printCutLineStyle.value
  context.save()
  context.strokeStyle = printCutLineColor.value
  context.lineWidth = lineWidth
  context.lineCap = style === 'dotted' ? 'round' : 'butt'
  context.setLineDash(style === 'dotted' ? [0, lineWidth * 2.5] : style === 'dashed' ? [lineWidth * 5, lineWidth * 3] : [])
  // A linha fica fora da carta para não cobrir a arte.
  const offset = lineWidth / 2
  context.strokeRect(x - offset, y - offset, width + lineWidth, height + lineWidth)
  context.restore()
}

async function generateDeckPrintSheets(downloadFormat: 'zip' | 'pdf'): Promise<void> {
  return withLoading(async () => {
    const deck = currentDeck()
    if (deck.cards.length === 0) {
      window.alert('Nao ha cartas no baralho para gerar baralho.')
      return
    }

    const layout = currentPrintLayout()
    if (layout.perSheet <= 0) {
      window.alert('Configuracao de baralho invalida.')
      return
    }

    const previousPdfText = generateDeckPrintPdfButton.textContent
    const previousZipText = generateDeckPrintZipButton.textContent
    generateDeckPrintZipButton.disabled = true
    generateDeckPrintPdfButton.disabled = true
    if (downloadFormat === 'pdf') {
      generateDeckPrintPdfButton.textContent = 'Gerando PDF...'
    } else {
      generateDeckPrintZipButton.textContent = 'Gerando ZIP...'
    }

    try {
      const cardImages = await Promise.all(
        deck.cards.map(async (card) => captureDeckCardPrintImage(deck, card.id)),
      )
      const imageElements = await Promise.all(cardImages.map(async (src) => loadImageElement(src)))
      const includeBack = printIncludeBackSwitch.checked
      const backImages = new Map<string, HTMLImageElement>()
      if (includeBack) {
        for (const backId of new Set(deck.cards.map(c => c.backId))) {
          const back = deck.backs.find(b => b.id === backId) ?? deck.backs[0]
          backImages.set(backId, await loadImageElement(await captureDeckBackPrintImage(back)))
        }
      }

      const totalPages = Math.ceil(deck.cards.length / layout.perSheet)
      const paperWidthPx = mmToPx(layout.paper.widthMm)
      const paperHeightPx = mmToPx(layout.paper.heightMm)
      const cardWidthPx = mmToPx(layout.card.widthMm)
      const cardHeightPx = mmToPx(layout.card.heightMm)
      const gapPx = mmToPx(layout.gapMm)
      const marginPx = mmToPx(layout.sideMarginMm)
      const baseName = slugifyFilename(deck.name)
      const zip = downloadFormat === 'zip' ? new JSZip() : null
      const pdf = downloadFormat === 'pdf'
        ? new jsPDF({
          orientation: layout.paper.widthMm > layout.paper.heightMm ? 'landscape' : 'portrait',
          unit: 'mm',
          format: [layout.paper.widthMm, layout.paper.heightMm],
          compress: true,
        })
        : null

      for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
        const sides: Array<'frente' | 'verso'> = includeBack ? ['frente', 'verso'] : ['frente']
        for (const side of sides) {
          const sheetCanvas = document.createElement('canvas')
          sheetCanvas.width = paperWidthPx
          sheetCanvas.height = paperHeightPx
          const context = sheetCanvas.getContext('2d')
          if (!context) throw new Error('Falha ao preparar canvas de impressao.')

          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, paperWidthPx, paperHeightPx)

          for (let slot = 0; slot < layout.perSheet; slot += 1) {
            const cardIndex = pageIndex * layout.perSheet + slot
            if (cardIndex >= cardImages.length) break

            const row = Math.floor(slot / layout.columns)
            const frontCol = slot % layout.columns
            const col = side === 'verso' ? layout.columns - 1 - frontCol : frontCol
            const x = marginPx + col * (cardWidthPx + gapPx)
            const y = marginPx + row * (cardHeightPx + gapPx)
            const printImage = side === 'verso' ? backImages.get(deck.cards[cardIndex].backId) : imageElements[cardIndex]
            if (!printImage) throw new Error('Falha ao preparar o verso para impressao.')
            context.drawImage(printImage, x, y, cardWidthPx, cardHeightPx)
            if (printCutLineEnabled.checked) drawCutGuide(context, x, y, cardWidthPx, cardHeightPx)
          }

          if (downloadFormat === 'zip' && zip) {
            const blob = await canvasToBlob(sheetCanvas)
            zip.file(`${baseName}-${String(pageIndex + 1).padStart(2, '0')}-${side}.png`, blob)
          }

          if (downloadFormat === 'pdf' && pdf) {
            if (pageIndex > 0 || side === 'verso') pdf.addPage()
            pdf.addImage(sheetCanvas.toDataURL('image/png'), 'PNG', 0, 0, layout.paper.widthMm, layout.paper.heightMm, undefined, 'FAST')
          }
        }
      }

      if (downloadFormat === 'zip' && zip) {
        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        })
        downloadBlob(`${baseName}-impressao.zip`, zipBlob)
      }

      if (downloadFormat === 'pdf' && pdf) {
        const pdfBlob = pdf.output('blob')
        downloadBlob(`${baseName}-impressao.pdf`, pdfBlob)
      }

      closePrintModal()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Falha ao gerar folhas de impressao.')
    } finally {
      generateDeckPrintZipButton.disabled = false
      generateDeckPrintPdfButton.disabled = false
      generateDeckPrintPdfButton.textContent = previousPdfText
      generateDeckPrintZipButton.textContent = previousZipText
    }
  })
}

function updatePrintPreview(): void {
  const layout = currentPrintLayout()
  const total = Math.max(1, layout.columns * layout.rows)
  const previewCount = Math.min(PREVIEW_MAX_CARDS, total)

  const mmScale = Math.min(220 / layout.paper.widthMm, 300 / layout.paper.heightMm)
  const sheetWidthPx = Math.max(120, Math.round(layout.paper.widthMm * mmScale))
  const sheetHeightPx = Math.max(160, Math.round(layout.paper.heightMm * mmScale))
  const gapPx = Math.max(0, Math.round(layout.gapMm * mmScale))
  const cardWidthPx = Math.max(6, Math.floor(layout.card.widthMm * mmScale))
  const cardHeightPx = Math.max(6, Math.floor(layout.card.heightMm * mmScale))

  printPreviewSheet.style.width = `${sheetWidthPx}px`
  printPreviewSheet.style.height = `${sheetHeightPx}px`

  printPreviewGrid.style.gridTemplateColumns = `repeat(${layout.columns}, ${cardWidthPx}px)`
  printPreviewGrid.style.gridAutoRows = `${cardHeightPx}px`
  printPreviewGrid.style.gap = `${gapPx}px`
  printPreviewGrid.innerHTML = ''

  for (let i = 0; i < previewCount; i += 1) {
    const thumb = document.createElement('div')
    thumb.className = 'print-preview-card'
    thumb.style.width = `${cardWidthPx}px`
    thumb.style.height = `${cardHeightPx}px`
    if (printCutLineEnabled.checked) {
      thumb.style.outline = `${Math.max(1, Math.round(clamp(0.1, 2, Number(printCutLineWidth.value) || 0.2) * mmScale))}px ${printCutLineStyle.value} ${printCutLineColor.value}`
    }
    const caption = document.createElement('span')
    caption.textContent = String(i + 1)
    thumb.append(caption)
    printPreviewGrid.append(thumb)
  }

  const limitedLabel = total > previewCount ? ` (mostrando ${previewCount})` : ''
  const orientationLabel = printOrientationSelect.value === 'landscape' ? 'Paisagem' : 'Retrato'
  const sidesLabel = printIncludeBackSwitch.checked ? 'frente e verso' : 'somente frente'
  printLayoutSummary.textContent = `${orientationLabel}: ${layout.columns} colunas x ${layout.rows} linhas = ${total} cartas por folha${limitedLabel} (${sidesLabel})`
}

function openPrintModal(): void {
  printModal.hidden = false
  updatePrintPreview()
}

function closePrintModal(): void {
  printModal.hidden = true
}

function syncPrintCustomFieldsVisibility(): void {
  const customSelected = printCardSizeSelect.value === 'custom'
  printCustomSizeRow.hidden = !customSelected
  printCustomSizeRow.style.display = customSelected ? 'grid' : 'none'
}

function attachCanvasDnD(): void {
  canvasStage.addEventListener('dragover', (event) => {
    event.preventDefault()
  })

  canvasStage.addEventListener('drop', async (event) => {
    event.preventDefault()
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        continue
      }

      try {
        const dataUrl = await fileToObjectUrl(file)
        await addImageLayer(dataUrl, file.name)
      } catch {
        window.alert(`Falha ao carregar a imagem ${file.name}.`)
      }
    }
  })
}

function attachImageCropPanning(): void {
  const surface = canvas.upperCanvasEl
  let drag: {
    pointerId: number
    object: FabricImage
    startX: number
    startY: number
    startCropX: number
    startCropY: number
    maxCropX: number
    maxCropY: number
    scaleX: number
    scaleY: number
  } | null = null

  surface.addEventListener('pointerdown', (event) => {
    if (!cropPanLayerId) return
    const object = layerById.get(cropPanLayerId)
    if (!(object instanceof FabricImage) || canvas.getActiveObject() !== object) return
    const meta = getLayerMeta(object)
    if (normalizeImageFit(meta.fit ?? 'contain') !== 'cover') return

    const natural = naturalImageBox(object)
    drag = {
      pointerId: event.pointerId,
      object,
      startX: event.clientX,
      startY: event.clientY,
      startCropX: object.cropX ?? 0,
      startCropY: object.cropY ?? 0,
      maxCropX: Math.max(0, natural.width - (object.width ?? natural.width)),
      maxCropY: Math.max(0, natural.height - (object.height ?? natural.height)),
      scaleX: Math.max(0.0001, Math.abs(object.scaleX ?? 1)),
      scaleY: Math.max(0.0001, Math.abs(object.scaleY ?? 1)),
    }
    surface.setPointerCapture(event.pointerId)
    surface.classList.add('is-crop-dragging')
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  surface.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const displayScale = Math.max(0.0001, canvasDisplayZoom)
    const cropX = clamp(0, drag.maxCropX, drag.startCropX - (event.clientX - drag.startX) / displayScale / drag.scaleX)
    const cropY = clamp(0, drag.maxCropY, drag.startCropY - (event.clientY - drag.startY) / displayScale / drag.scaleY)
    const meta = getLayerMeta(drag.object)
    setLayerMeta(drag.object, {
      ...meta,
      cropPositionX: drag.maxCropX > 0 ? cropX / drag.maxCropX : 0.5,
      cropPositionY: drag.maxCropY > 0 ? cropY / drag.maxCropY : 0.5,
    })
    applyImageFitForObject(drag.object, 'cover')
    drag.object.setCoords()
    canvas.requestRenderAll()
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  const stopDragging = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    surface.releasePointerCapture(event.pointerId)
    surface.classList.remove('is-crop-dragging')
    persistActiveDeckDocument()
    renderCardThumbnails()
    drag = null
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  surface.addEventListener('pointerup', stopDragging, true)
  surface.addEventListener('pointercancel', stopDragging, true)
}

editModelButton.addEventListener('click', () => {
  if (activeEditMode === 'model') {
    activeRightPanelTab = 'model-layers'
    renderWorkspaceTabs()
    return
  }
  void switchToModelView()
})

editDeckButton.addEventListener('click', () => {
  if (activeEditMode !== 'deck') {
    deckPreviewHidden = false
    localStorage.setItem(DECK_PREVIEW_HIDDEN_STORAGE_KEY, 'false')
    void switchToCardView()
    return
  }

  deckPreviewHidden = !deckPreviewHidden
  localStorage.setItem(DECK_PREVIEW_HIDDEN_STORAGE_KEY, String(deckPreviewHidden))
  syncDeckPreviewVisibility()
  fitCanvasZoomToStage()
})
exportDeckButton.addEventListener('click', saveActiveDeckAsFile)
deckNameInput.addEventListener('input', () => {
  currentDeck().name = deckNameInput.value
})

editBackButton.addEventListener('click', () => {
  if (activeEditMode === 'back') {
    activeRightPanelTab = 'model-layers'
    renderWorkspaceTabs()
    return
  }
  void switchToBackView()
})
deckNameInput.addEventListener('change', syncDeckFilename)

variantSelect.addEventListener('change', () => { void switchVariant(variantSelect.value) })
variantNewButton.addEventListener('click', () => { void addVariant() })
variantDuplicateButton.addEventListener('click', () => { void duplicateVariant() })
variantNameInput.addEventListener('input', renameVariant)
variantDeleteButton.addEventListener('click', () => { void deleteVariant() })
cardModelSelect.addEventListener('change', () => { void changeActiveCardModel(cardModelSelect.value) })
cardBackSelect.addEventListener('change', () => { changeActiveCardBack(cardBackSelect.value) })

importDeckButton.addEventListener('click', () => {
  importDeckInput.click()
})

interface PresetDeckEntry { name: string; file: string; description?: string; cover?: string }

const presetCoverCache = new Map<string, Promise<string>>()

function fetchPresetCover(file: string): Promise<string> {
  let cached = presetCoverCache.get(file)
  if (!cached) {
    cached = (async () => {
      const res = await fetch(presetDeckUrl(file))
      if (!res.ok) return ''
      const parsed = JSON.parse(await decompressDeckText(new File([await res.blob()], file))) as Record<string, unknown>
      const deck = (parsed['deck'] ?? parsed) as Record<string, unknown>
      if (typeof deck['cover'] === 'string' && deck['cover']) return deck['cover']
      if (typeof parsed['cover'] === 'string' && parsed['cover']) return parsed['cover']
      const backs = Array.isArray(deck['backs']) ? deck['backs'] as Array<Record<string, unknown>> : []
      const activeBackId = typeof deck['activeBackId'] === 'string' ? deck['activeBackId'] : ''
      const activeBack = backs.find((back) => back['id'] === activeBackId)
      const backThumbnail = activeBack?.['thumbnail'] || backs[0]?.['thumbnail']
      if (typeof backThumbnail === 'string' && backThumbnail) return backThumbnail
      const firstCard = Array.isArray(deck['cards']) ? deck['cards'][0] as Record<string, unknown> | undefined : undefined
      return typeof firstCard?.['thumbnail'] === 'string' ? firstCard['thumbnail'] : ''
    })().catch(() => '')
    presetCoverCache.set(file, cached)
  }
  return cached
}

deckCoverUploadButton.addEventListener('click', () => { deckCoverInput.click() })
deckCoverInput.addEventListener('change', async () => {
  const file = deckCoverInput.files?.[0]
  deckCoverInput.value = ''
  if (!file) return
  try {
    currentDeck().cover = await resizeCoverDataUrl(file)
    applyDeckCover()
  } catch {
    window.alert('Falha ao carregar a capa.')
  }
})
deckCoverRemoveButton.addEventListener('click', () => {
  currentDeck().cover = ''
  applyDeckCover()
})
coverSwitchButtons.forEach((button) => {
  button.addEventListener('click', () => {
    coverMode = button.dataset.coverMode as CoverMode
    applyDeckCover()
  })
})
applyDeckCover()

function presetDeckUrl(file: string): string {
  return `${import.meta.env.BASE_URL}decks/${encodeURIComponent(file)}`
}

async function loadPresetDecks(): Promise<void> {
  presetDeckList.replaceChildren()
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}decks/index.json`, { cache: 'no-cache' })
    if (!response.ok) throw new Error('manifest')
    const entries = (await response.json()) as PresetDeckEntry[]
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('empty')

    for (const entry of entries) {
      const li = document.createElement('li')
      li.className = 'preset-deck-item'

      const cover = document.createElement('div')
      cover.className = 'preset-deck-cover'
      if (entry.cover) {
        cover.style.backgroundImage = `url("${import.meta.env.BASE_URL}decks/${entry.cover.split('/').map(encodeURIComponent).join('/')}")`
      } else {
        void fetchPresetCover(entry.file).then((src) => {
          if (src) cover.style.backgroundImage = `url("${src}")`
        })
      }
      li.append(cover)

      const info = document.createElement('div')
      info.className = 'preset-deck-info'
      const title = document.createElement('strong')
      title.textContent = entry.name
      info.append(title)
      if (entry.description) {
        const desc = document.createElement('span')
        desc.textContent = entry.description
        info.append(desc)
      }

      const actions = document.createElement('div')
      actions.className = 'preset-deck-actions'

      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.className = 'preset-deck-btn'
      editBtn.textContent = 'Editar'
      editBtn.addEventListener('click', () => {
        void withLoading(async () => {
          try {
            const res = await fetch(presetDeckUrl(entry.file))
            if (!res.ok) throw new Error('Não foi possível carregar o deck.')
            const blob = await res.blob()
            await importDeckFile(new File([blob], `${entry.name}.deck`))
            presetDecksModal.hidden = true
          } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Falha ao carregar deck.')
          }
        })
      })

      const link = document.createElement('a')
      link.className = 'preset-deck-btn'
      link.href = presetDeckUrl(entry.file)
      link.download = `${entry.name}.deck`
      link.textContent = 'Baixar'

      actions.append(editBtn, link)
      li.append(info, actions)
      presetDeckList.append(li)
    }
  } catch {
    const li = document.createElement('li')
    li.className = 'hint'
    li.textContent = 'Nenhum deck disponível.'
    presetDeckList.replaceChildren(li)
  }
}

openPresetDecksButton.addEventListener('click', () => {
  presetDecksModal.hidden = false
  void loadPresetDecks()
})
closePresetDecksButton.addEventListener('click', () => { presetDecksModal.hidden = true })
presetDecksBackdrop.addEventListener('click', () => { presetDecksModal.hidden = true })

importDeckInput.addEventListener('change', async () => {
  const file = importDeckInput.files?.[0]
  if (!file) {
    return
  }

  try {
    await importDeckFile(file)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Falha ao carregar .deck.')
  } finally {
    importDeckInput.value = ''
  }
})

addCardButton.addEventListener('click', () => { void addNewCard() })

addGraphicButton.addEventListener('click', () => {
  assetsModal.hidden = true
  void addGraphicReferenceLayer()
})

openAssetsButton.addEventListener('click', () => {
  renderLibrary()
  assetsModal.hidden = false
})
closeAssetsButton.addEventListener('click', () => { assetsModal.hidden = true })
assetsModalBackdrop.addEventListener('click', () => { assetsModal.hidden = true })
libraryUploadButton.addEventListener('click', () => { libraryInput.click() })
libraryInput.addEventListener('change', async () => {
  const files = libraryInput.files
  if (!files || files.length === 0) return
  try {
    await addFilesToLibrary(files)
  } catch {
    window.alert('Falha ao adicionar imagem à biblioteca.')
  } finally {
    libraryInput.value = ''
  }
})

shapePalette.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-shape]')
  if (!button || button.disabled) return
  addShapeLayer(button.dataset.shape as ShapeType)
  assetsModal.hidden = true
})

addTextButton.addEventListener('click', () => {
  assetsModal.hidden = true
  addTextLayer()
})

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0]
  if (!file) {
    return
  }

  try {
    const dataUrl = await fileToObjectUrl(file)
    const activeObject = selectedEditableImageObject()

    if (activeObject) {
      const fit = normalizeImageFit(getLayerMeta(activeObject).fit ?? 'cover')
      await replaceIllustrationOnObject(activeObject, dataUrl, fit)
      applyRuntimeConfig(activeObject)
      persistActiveDeckDocument()
      renderLayersAccordion()
      canvas.requestRenderAll()
    } else {
      await addImageLayer(dataUrl, file.name)
    }
  } catch {
    window.alert('Falha ao carregar imagem selecionada.')
  } finally {
    imageInput.value = ''
  }
})

exportPngButton.addEventListener('click', exportCanvasPng)

openPrintModalButton.addEventListener('click', () => {
  syncPrintCustomFieldsVisibility()
  openPrintModal()
})

function setMainMenuOpen(open: boolean): void {
  mainMenuPanel.hidden = !open
  mainMenuButton.setAttribute('aria-expanded', String(open))
}

mainMenuButton.addEventListener('click', () => { setMainMenuOpen(mainMenuPanel.hidden === true) })
mainMenuPanel.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('.menu-item, .menu-cta, .template-launch-button')) setMainMenuOpen(false)
})
document.addEventListener('click', (event) => {
  if (!mainMenuPanel.hidden && !(event.target as HTMLElement).closest('.menu-dropdown')) setMainMenuOpen(false)
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !assetsModal.hidden) {
    assetsModal.hidden = true
  }
  if (event.key === 'Escape' && !mainMenuPanel.hidden) {
    setMainMenuOpen(false)
    mainMenuButton.focus()
  }
})

openTemplatesButton.addEventListener('click', () => {
  renderTemplateGallery()
  templatesModal.hidden = false
})

closeTemplatesModalButton.addEventListener('click', () => {
  templatesModal.hidden = true
})

templatesModalBackdrop.addEventListener('click', () => {
  templatesModal.hidden = true
})

closePrintModalButton.addEventListener('click', closePrintModal)
printModalBackdrop.addEventListener('click', closePrintModal)

printCardSizeSelect.addEventListener('change', () => {
  syncPrintCustomFieldsVisibility()
  updatePrintPreview()
})
printCardWidthInput.addEventListener('input', updatePrintPreview)
printCardHeightInput.addEventListener('input', updatePrintPreview)
printPaperSizeSelect.addEventListener('change', updatePrintPreview)
printOrientationSelect.addEventListener('change', updatePrintPreview)
printGapInput.addEventListener('input', updatePrintPreview)
printIncludeBackSwitch.addEventListener('change', updatePrintPreview)
printCutLineEnabled.addEventListener('change', () => {
  printCutLineOptions.hidden = !printCutLineEnabled.checked
  updatePrintPreview()
})
printCutLineWidth.addEventListener('input', updatePrintPreview)
printCutLineColor.addEventListener('input', updatePrintPreview)
printCutLineStyle.addEventListener('change', updatePrintPreview)
generateDeckPrintZipButton.addEventListener('click', () => {
  void generateDeckPrintSheets('zip')
})

generateDeckPrintPdfButton.addEventListener('click', () => {
  void generateDeckPrintSheets('pdf')
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !presetDecksModal.hidden) {
    presetDecksModal.hidden = true
  }
  if (event.key === 'Escape' && !printModal.hidden) {
    closePrintModal()
  }
  if (event.key === 'Escape' && !templatesModal.hidden) {
    templatesModal.hidden = true
  }
  if (event.key === 'Escape' && !newCardModal.hidden) {
    newCardModal.hidden = true
  }
})

canvas.upperCanvasEl.addEventListener('dblclick', () => {
  const active = canvas.getActiveObject()
  if (active instanceof FabricImage) {
    const meta = getLayerMeta(active)
    if (meta.kind === 'graphic') {
      if (meta.scope === activeEditMode && !meta.locked && !meta.isBackground) void chooseAssetForGraphic(active)
      return
    }
  }
  openIllustrationUpload()
})

zoomOutButton.addEventListener('click', () => {
  setCanvasZoom(currentZoom() - ZOOM_STEP)
})

zoomInButton.addEventListener('click', () => {
  setCanvasZoom(currentZoom() + ZOOM_STEP)
})

zoomRange.addEventListener('input', () => {
  const value = Number(zoomRange.value) || 100
  setCanvasZoom(value / 100)
})

zoomFitButton.addEventListener('click', () => {
  fitCanvasZoomToStage()
})

canvasPanel.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return

  event.preventDefault()
  const direction = event.deltaY < 0 ? 1 : -1
  setCanvasZoom(currentZoom() + direction * ZOOM_STEP)
}, { passive: false })

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    void saveActiveDeckAsFile()
    return
  }

  if (isEditingField(event.target)) {
    return
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'd') {
      event.preventDefault()
      void duplicateSelectedGraphic()
      return
    }
    if (key === 'c') {
      void copySelectedGraphic()
      return
    }
    if (key === 'v' && copiedGraphic) {
      event.preventDefault()
      void pasteCopiedGraphic()
      return
    }
    if (key === 'z' || key === 'y') {
      event.preventDefault()
      void stepHistory(key === 'y' || event.shiftKey ? 1 : -1)
      return
    }
  }

  if (event.key === 'Delete') {
    event.preventDefault()
    removeSelectedLayer()
    return
  }

  if (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown'
  ) {
    const moved = nudgeSelectedLayer(event.key)
    if (moved) {
      event.preventDefault()
    }
  }
})

canvas.on('selection:created', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('selection:updated', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('selection:cleared', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('mouse:down', (event) => {
  const target = event.target
  if (!target || !(event.e as MouseEvent).altKey || target instanceof ActiveSelection) return
  // Alt+arrastar: a cópia fica na posição original e o objeto arrastado segue o mouse.
  const index = canvas.getObjects().indexOf(target)
  void duplicateGraphic(target, 0).then((copy) => {
    if (!copy) return
    canvas.insertAt(index, copy)
    refreshLayerIndex()
    renderLayersAccordion()
    canvas.requestRenderAll()
  })
})

canvas.on('object:modified', (e) => {
  const obj = e.target
  if (obj instanceof FabricImage) {
    const meta = getLayerMeta(obj)
    if (meta.kind === 'image') {
      // keep slot dimensions in sync with the object's visual size after any transform
      setLayerMeta(obj, { ...meta, slotWidth: Math.max(1, obj.getScaledWidth()), slotHeight: Math.max(1, obj.getScaledHeight()) })
    }
  }
  if (activeEditMode !== 'deck') {
    renderLayersAccordion()
  } else {
    renderWorkspaceTabs()
  }
  persistActiveDeckDocument()
})

canvas.on('object:added', (event) => {
  const object = event.target
  if (!object) {
    return
  }

  applyRuntimeConfig(object)
  refreshLayerIndex()
})

window.addEventListener('resize', () => {
  fitCanvasZoomToStage()
  syncBackToEditorButton()
})

attachCanvasDnD()
attachImageCropPanning()
renderWorkspaceSidebar()
syncModeControls()
syncBackToEditorButton()
void loadActiveDeckCard(currentDeck()).then(async () => {
  await refreshDeckThumbnails(currentDeck())
})
setTimeout(() => {
  fitCanvasZoomToStage()
}, 0)
