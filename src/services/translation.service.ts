import axios, { AxiosError } from "axios";
import {
  DEFAULT_TRANSLATION_MODEL,
  TRANSLATION_SYSTEM_PROMPT,
  TranslationSegments,
  SummaryItem,
  buildArticlePrompt,
  buildSummariesPrompt,
  chunkHtml,
  parseArticleResponse,
  parseSummariesResponse,
  toDirectModelId,
  toGatewayModelId,
  validateTranslation,
} from "../utils/translation.helpers";

// Traducción ES → EN con Claude.
// Proveedor:
//   1. ANTHROPIC_API_KEY definida → API de Anthropic directa.
//   2. Si no → Vercel AI Gateway (AI_GATEWAY_API_KEY o el token OIDC de Vercel).
// Modelo: TRANSLATION_MODEL (por defecto claude-haiku-4-5).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";

export const CHUNK_MAX_CHARS = 20_000; // por encima se traduce por bloques
// Artículos más grandes no se traducen. Con trozos de 20K traducidos en paralelo, el trabajo
// cabe holgado en el maxDuration (300 s) de la función.
export const MAX_CONTENT_CHARS = 100_000;
const MAX_OUTPUT_TOKENS = 16_000;
const ARTICLE_TIMEOUT_MS = 150_000;

export class TranslationError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranslationError";
    this.status = status;
  }
}

export interface LlmCredentials {
  oidcToken?: string; // header x-vercel-oidc-token de la petición en curso
}

export function translationModel(): string {
  return process.env.TRANSLATION_MODEL?.trim() || DEFAULT_TRANSLATION_MODEL;
}

// ¿Hay alguna forma de llamar al LLM?
export function hasLlmCredentials(creds: LlmCredentials = {}): boolean {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    creds.oidcToken ||
    process.env.VERCEL_OIDC_TOKEN
  );
}

interface LlmCall {
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

interface LlmResult {
  text: string;
  model: string;
}

// Punto de inyección para pruebas (sustituye la llamada HTTP).
type Transport = (url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) => Promise<any>;

let transport: Transport = async (url, body, headers, timeoutMs) => {
  const res = await axios.post(url, body, { headers, timeout: timeoutMs });
  return res.data;
};

export function __setTransportForTests(t: Transport) {
  transport = t;
}

async function callClaude(call: LlmCall, creds: LlmCredentials): Promise<LlmResult> {
  const configured = translationModel();
  const directKey = process.env.ANTHROPIC_API_KEY;
  let url: string;
  let model: string;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  if (directKey) {
    url = ANTHROPIC_URL;
    model = toDirectModelId(configured);
    headers["x-api-key"] = directKey;
  } else {
    const token = process.env.AI_GATEWAY_API_KEY || creds.oidcToken || process.env.VERCEL_OIDC_TOKEN;
    if (!token) throw new TranslationError("No hay credenciales para el LLM (ANTHROPIC_API_KEY / AI Gateway)");
    url = GATEWAY_URL;
    model = toGatewayModelId(configured);
    headers.authorization = `Bearer ${token}`;
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: call.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.prompt }],
  };
  // Haiku acepta temperature; los modelos de la generación 5 la rechazan.
  if (/haiku/.test(model)) body.temperature = 0.2;

  let data: any;
  try {
    data = await transport(url, body, headers, call.timeoutMs);
  } catch (err) {
    const ax = err as AxiosError<any>;
    const status = ax.response?.status;
    const detail = ax.response?.data?.error?.message || ax.message;
    throw new TranslationError(`LLM ${status || "error"}: ${String(detail).slice(0, 300)}`, status);
  }

  if (data?.stop_reason === "refusal") throw new TranslationError("El modelo rechazó la traducción");
  if (data?.stop_reason === "max_tokens") throw new TranslationError("Respuesta truncada (max_tokens)");
  const text = Array.isArray(data?.content)
    ? data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
    : "";
  if (!text.trim()) throw new TranslationError("Respuesta vacía del LLM");
  return { text, model: data?.model || model };
}

async function translateSegments(
  seg: TranslationSegments,
  creds: LlmCredentials,
  part?: { index: number; total: number }
): Promise<{ seg: TranslationSegments; model: string }> {
  const { text, model } = await callClaude(
    {
      system: TRANSLATION_SYSTEM_PROMPT,
      prompt: buildArticlePrompt(seg, part),
      maxTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: ARTICLE_TIMEOUT_MS,
    },
    creds
  );
  const parsed = parseArticleResponse(text, seg);
  const problem = validateTranslation(seg, parsed);
  if (problem) throw new TranslationError(problem);
  return { seg: parsed, model };
}

export interface TranslatedArticle {
  title: string;
  excerpt: string;
  content: string;
  model: string;
}

// Traduce un artículo completo. Si el contenido es largo lo divide en bloques de
// primer nivel para que nunca se trunque la salida.
export async function translateArticle(source: Required<TranslationSegments>, creds: LlmCredentials = {}): Promise<TranslatedArticle> {
  if (source.content.length > MAX_CONTENT_CHARS) {
    throw new TranslationError(`Contenido demasiado grande para traducir (${source.content.length} caracteres)`);
  }
  const chunks = chunkHtml(source.content, CHUNK_MAX_CHARS);
  const total = chunks.length;

  // Los trozos son independientes: se traducen en paralelo para que el tiempo total sea el
  // de un solo trozo (una traducción secuencial podía superar el maxDuration de la función).
  const [first, ...rest] = await Promise.all(
    chunks.map((chunk, i) =>
      translateSegments(
        i === 0 ? { title: source.title, excerpt: source.excerpt, content: chunk } : { content: chunk },
        creds,
        { index: i, total }
      )
    )
  );
  const contentParts = [first.seg.content || "", ...rest.map((r) => r.seg.content || "")];

  return {
    title: first.seg.title || "",
    excerpt: first.seg.excerpt || "",
    content: contentParts.join("\n"),
    model: first.model,
  };
}

// Traduce títulos + extractos de varios artículos en una sola llamada (listado).
// Devuelve solo los ítems que vinieron bien; los demás se sirven en español.
export async function translateSummaries(
  items: SummaryItem[],
  creds: LlmCredentials = {},
  timeoutMs = 20_000
): Promise<{ results: Map<string, { title: string; excerpt: string }>; model: string }> {
  if (!items.length) return { results: new Map(), model: translationModel() };
  const { text, model } = await callClaude(
    {
      system: TRANSLATION_SYSTEM_PROMPT,
      prompt: buildSummariesPrompt(items),
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, 400 + items.length * 400),
      timeoutMs,
    },
    creds
  );
  const results = parseSummariesResponse(text, items);
  // validación ligera por ítem
  for (const it of items) {
    const r = results.get(it.id);
    if (r && validateTranslation({ title: it.title, excerpt: it.excerpt }, r)) results.delete(it.id);
  }
  return { results, model };
}
