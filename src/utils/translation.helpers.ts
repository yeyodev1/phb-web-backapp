import crypto from "crypto";

// Funciones puras (sin DB ni red) para la traducción automática de artículos.
// Se pueden probar de forma aislada.

export type TranslationStatus = "ready" | "pending" | "failed";

export interface ArticleSource {
  title?: string;
  excerpt?: string;
  content?: string;
}

export interface EnTranslation {
  title?: string;
  excerpt?: string;
  content?: string;
  sourceHash?: string; // hash del artículo en español con el que se generó la traducción completa
  summaryHash?: string; // hash de título + extracto con el que se generó title/excerpt
  status?: TranslationStatus;
  model?: string;
  translatedAt?: Date;
  error?: string;
  startedAt?: Date;
  failedAt?: Date;
}

// Estado derivado que se muestra en el admin.
export type AdminTranslationState = "ready" | "pending" | "stale" | "failed" | "none";

export const LOCK_TTL_MS = 5 * 60 * 1000; // un "pending" más antiguo se considera abandonado
export const FAILED_BACKOFF_MS = 10 * 60 * 1000; // tras un fallo no se reintenta en automático durante 10 min

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

// Hash del artículo completo en español (título + extracto + contenido).
export function hashSource(a: ArticleSource): string {
  return sha256(`${a.title || ""}\u0000${a.excerpt || ""}\u0000${a.content || ""}`);
}

// Hash solo de título + extracto (para las tarjetas del listado).
export function hashSummary(a: ArticleSource): string {
  return sha256(`${a.title || ""}\u0000${a.excerpt || ""}`);
}

export function isFullFresh(source: ArticleSource, en?: EnTranslation | null): boolean {
  return !!en && en.status === "ready" && !!en.title && en.sourceHash === hashSource(source);
}

export function isSummaryFresh(source: ArticleSource, en?: EnTranslation | null): boolean {
  if (!en || !en.title) return false;
  if (isFullFresh(source, en)) return true;
  return en.summaryHash === hashSummary(source);
}

export function isLockActive(en?: EnTranslation | null, now = Date.now()): boolean {
  return (
    !!en &&
    en.status === "pending" &&
    !!en.startedAt &&
    now - new Date(en.startedAt).getTime() < LOCK_TTL_MS
  );
}

export function isRecentlyFailed(en?: EnTranslation | null, now = Date.now()): boolean {
  if (!en || en.status !== "failed") return false;
  const at = en.failedAt || en.startedAt;
  return !!at && now - new Date(at).getTime() < FAILED_BACKOFF_MS;
}

export function adminTranslationState(source: ArticleSource, en?: EnTranslation | null): AdminTranslationState {
  if (isLockActive(en)) return "pending";
  if (isFullFresh(source, en)) return "ready";
  if (en?.status === "failed") return "failed";
  if (en?.status === "ready" || (en?.title && en?.content)) return "stale";
  return "none";
}

// ---------------------------------------------------------------------------
// Modelos: el gateway de Vercel usa "anthropic/claude-haiku-4.5" (con punto),
// la API directa de Anthropic usa "claude-haiku-4-5" (con guion).
// ---------------------------------------------------------------------------
export const DEFAULT_TRANSLATION_MODEL = "claude-haiku-4-5";

export function toDirectModelId(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/(\d)\.(\d)/g, "$1-$2");
}

export function toGatewayModelId(model: string): string {
  if (model.includes("/")) return model;
  // quita el sufijo de snapshot (-20251001) y convierte "4-5" final en "4.5"
  const base = model.replace(/-\d{8}$/, "").replace(/-(\d)-(\d)$/, "-$1.$2");
  return `anthropic/${base}`;
}

// ---------------------------------------------------------------------------
// HTML: conteo de etiquetas y partición por bloques de primer nivel
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

// Cuenta etiquetas de apertura (incluye void). Ignora comentarios.
export function countOpeningTags(html: string): number {
  const withoutComments = (html || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = withoutComments.match(/<[a-zA-Z][a-zA-Z0-9-]*(?=[\s>/])/g);
  return m ? m.length : 0;
}

// Divide el HTML en bloques de primer nivel (profundidad 0), sin cortar nunca
// dentro de una etiqueta. Texto suelto de primer nivel queda como su propio bloque.
export function splitTopLevelBlocks(html: string): string[] {
  const blocks: string[] = [];
  const src = html || "";
  let depth = 0;
  let blockStart = 0;
  let i = 0;
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/y;

  const pushBlock = (end: number) => {
    const piece = src.slice(blockStart, end);
    if (piece.trim()) blocks.push(piece);
    // el espacio en blanco entre bloques se pega al bloque anterior (no se pierde)
    else if (piece && blocks.length) blocks[blocks.length - 1] += piece;
    else if (piece) return; // espacio inicial: se queda para el siguiente bloque
    blockStart = end;
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    tagRe.lastIndex = lt;
    const m = tagRe.exec(src);
    if (!m) {
      i = lt + 1;
      continue;
    }
    const full = m[0];
    const name = (m[1] || "").toLowerCase();
    const end = lt + full.length;

    if (full.startsWith("<!--")) {
      if (depth === 0) {
        pushBlock(lt);
        pushBlock(end);
      }
      i = end;
      continue;
    }

    const isClose = full.startsWith("</");
    const selfClosing = full.endsWith("/>") || VOID_TAGS.has(name);

    if (isClose) {
      depth = Math.max(0, depth - 1);
      i = end;
      if (depth === 0) pushBlock(end);
      continue;
    }

    if (depth === 0) pushBlock(lt); // texto suelto previo

    if (selfClosing) {
      i = end;
      if (depth === 0) pushBlock(end);
      continue;
    }

    if (RAW_TEXT_TAGS.has(name)) {
      const closeIdx = src.toLowerCase().indexOf(`</${name}`, end);
      const closeEnd = closeIdx === -1 ? src.length : src.indexOf(">", closeIdx) + 1 || src.length;
      i = closeEnd;
      if (depth === 0) pushBlock(closeEnd);
      continue;
    }

    depth++;
    i = end;
  }
  pushBlock(src.length);
  return blocks;
}

// Agrupa bloques en trozos de como máximo maxChars (un bloque más grande va solo).
export function chunkHtml(html: string, maxChars: number): string[] {
  if ((html || "").length <= maxChars) return [html || ""];
  const chunks: string[] = [];
  let current = "";
  for (const block of splitTopLevelBlocks(html)) {
    if (current && current.length + block.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += block;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Prompts y parseo de la respuesta (delimitadores, más robusto que JSON con HTML)
// ---------------------------------------------------------------------------
export const TRANSLATION_SYSTEM_PROMPT = `You are a professional medical translator. You translate Spanish health and medical articles from the blog of Dr. Juan Román Garza (regenerative medicine, stem cells, exosomes, longevity) into natural, accurate, fluent US English for patients and readers.

Rules:
- Translate ONLY human-readable text. Keep every HTML tag, attribute, class, id, style and the whole HTML structure exactly as in the source, in the same order. Do not add, remove, merge or reorder tags.
- Also translate the human text inside alt="" and title="" attributes. Never change href, src, srcset or any URL.
- Keep proper names, brand and product names (e.g. Powerhouse Biotech, PHB), clinic names, drug names and numbers as they are. Use standard English medical terminology.
- Do not summarize, explain, add notes or comments. Translate everything, nothing more.
- Reply using exactly the same delimiter lines as the input (e.g. <<<TITLE>>>, <<<EXCERPT>>>, <<<CONTENT>>>, <<<END>>>), each on its own line, and nothing outside them.`;

export interface TranslationSegments {
  title?: string;
  excerpt?: string;
  content?: string;
}

export function buildArticlePrompt(seg: TranslationSegments, part?: { index: number; total: number }): string {
  const lines: string[] = [];
  if (part && part.total > 1) {
    lines.push(`This is part ${part.index + 1} of ${part.total} of one article. Translate just this part.`);
  }
  lines.push("Translate the following from Spanish to English:", "");
  if (seg.title !== undefined) lines.push("<<<TITLE>>>", seg.title);
  if (seg.excerpt !== undefined) lines.push("<<<EXCERPT>>>", seg.excerpt);
  if (seg.content !== undefined) lines.push("<<<CONTENT>>>", seg.content);
  lines.push("<<<END>>>");
  return lines.join("\n");
}

const MARKERS = ["TITLE", "EXCERPT", "CONTENT"] as const;

export function parseArticleResponse(text: string, expected: TranslationSegments): TranslationSegments {
  const src = (text || "").replace(/\r\n/g, "\n");
  const out: TranslationSegments = {};
  for (const key of MARKERS) {
    const field = key.toLowerCase() as keyof TranslationSegments;
    if (expected[field] === undefined) continue;
    const start = src.indexOf(`<<<${key}>>>`);
    if (start === -1) throw new Error(`Falta el delimitador <<<${key}>>> en la respuesta`);
    const from = start + `<<<${key}>>>`.length;
    const next = src.slice(from).search(/<<<(TITLE|EXCERPT|CONTENT|END)>>>/);
    const value = next === -1 ? src.slice(from) : src.slice(from, from + next);
    out[field] = value.trim();
  }
  return out;
}

// Traducción por lotes de título + extracto (listado).
export interface SummaryItem {
  id: string;
  title: string;
  excerpt: string;
}

export function buildSummariesPrompt(items: SummaryItem[]): string {
  const lines = [
    "Translate the title and excerpt of each of the following items from Spanish to English.",
    "Keep each <<<ITEM n>>> line exactly as given.",
    "",
  ];
  items.forEach((it, i) => {
    lines.push(`<<<ITEM ${i + 1}>>>`, "<<<TITLE>>>", it.title, "<<<EXCERPT>>>", it.excerpt);
  });
  lines.push("<<<END>>>");
  return lines.join("\n");
}

export function parseSummariesResponse(text: string, items: SummaryItem[]): Map<string, { title: string; excerpt: string }> {
  const result = new Map<string, { title: string; excerpt: string }>();
  const src = (text || "").replace(/\r\n/g, "\n");
  const parts = src.split(/<<<ITEM (\d+)>>>/);
  // parts = [antes, n1, cuerpo1, n2, cuerpo2, ...]
  for (let k = 1; k < parts.length; k += 2) {
    const idx = parseInt(parts[k], 10) - 1;
    const item = items[idx];
    if (!item) continue;
    const body = parts[k + 1] || "";
    try {
      const seg = parseArticleResponse(body, { title: "", excerpt: "" });
      if (!seg.title) continue;
      if (item.excerpt.trim() && !seg.excerpt) continue;
      result.set(item.id, { title: seg.title, excerpt: seg.excerpt || "" });
    } catch {
      // ítem mal formado: se ignora y se sirve en español
    }
  }
  return result;
}

// Valida que la traducción sea utilizable (no vacía, estructura HTML equivalente).
export function validateTranslation(source: TranslationSegments, translated: TranslationSegments): string | null {
  for (const key of ["title", "excerpt", "content"] as const) {
    const s = source[key];
    if (s === undefined) continue;
    const t = translated[key];
    if (s.trim() && !(t || "").trim()) return `El campo "${key}" vino vacío`;
    const sTags = countOpeningTags(s);
    const tTags = countOpeningTags(t || "");
    const tolerance = Math.max(2, Math.ceil(sTags * 0.05));
    if (Math.abs(sTags - tTags) > tolerance) {
      return `El campo "${key}" cambió la estructura HTML (${sTags} etiquetas → ${tTags})`;
    }
    // Una traducción no debería ser muchísimo más corta o larga que el original
    if (s.length > 200) {
      const ratio = (t || "").length / s.length;
      if (ratio < 0.5 || ratio > 2) return `El campo "${key}" tiene una longitud sospechosa (ratio ${ratio.toFixed(2)})`;
    }
  }
  return null;
}
