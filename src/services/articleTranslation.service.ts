import { Request } from "express";
import mongoose from "mongoose";
import { Article } from "../models/Article";
import { runInBackground } from "../utils/background";
import {
  EnTranslation,
  FAILED_BACKOFF_MS,
  LOCK_TTL_MS,
  adminTranslationState,
  hashSource,
  hashSummary,
  isFullFresh,
  isLockActive,
  isRecentlyFailed,
  isSummaryFresh,
} from "../utils/translation.helpers";
import {
  LlmCredentials,
  MAX_CONTENT_CHARS,
  hasLlmCredentials,
  translateArticle,
  translateSummaries,
} from "./translation.service";

// Orquestación de la traducción automática al inglés de los artículos:
// bloqueo atómico en Mongo, trabajos en segundo plano, lotes para el listado y backlog.
// El texto en español nunca se modifica aquí; solo se escribe en translations.en
// (con timestamps: false para no alterar updatedAt del artículo).

const MAX_BACKGROUND_JOBS = 3; // trabajos simultáneos por instancia
const MAX_SCHEDULED_PER_REQUEST = 3;
const SUMMARY_BACKOFF_MS = 2 * 60 * 1000;

let activeJobs = 0;
let summaryBackoffUntil = 0;

export function credsFromRequest(req: Request): LlmCredentials {
  const header = req.headers["x-vercel-oidc-token"];
  return { oidcToken: (Array.isArray(header) ? header[0] : header) || undefined };
}

export function translationInfo(doc: { title?: string; excerpt?: string; content?: string; translations?: { en?: EnTranslation } }) {
  const en = doc.translations?.en;
  return {
    status: adminTranslationState(doc, en),
    translatedAt: en?.translatedAt || null,
    model: en?.model || null,
    error: en?.status === "failed" ? en?.error || null : null,
  };
}

export type TranslateOutcome =
  | { status: "ready"; model: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "fresh" | "locked" | "backoff" | "not-found" };

// Reclama el artículo (status=pending) de forma atómica y lo traduce.
// - Nunca traduce dos veces el mismo hash (si ya está listo y fresco no se reclama).
// - Si otro proceso lo tiene reclamado hace menos de 5 min, no hace nada.
// - force: permite borradores, ignora el backoff de fallos y regenera aunque esté fresco.
export async function translateArticleNow(
  id: string,
  creds: LlmCredentials,
  opts: { force?: boolean } = {}
): Promise<TranslateOutcome> {
  const current = await Article.findById(id).select("title excerpt content isPublished").lean();
  if (!current || (!opts.force && !current.isPublished)) return { status: "skipped", reason: "not-found" };

  const hash = hashSource(current);
  const now = new Date();
  const startedAt = now;
  const nor: Record<string, unknown>[] = [];
  if (!opts.force) {
    nor.push({ "translations.en.status": "ready", "translations.en.sourceHash": hash });
    nor.push({ "translations.en.status": "failed", "translations.en.failedAt": { $gt: new Date(now.getTime() - FAILED_BACKOFF_MS) } });
  }
  const filter: Record<string, unknown> = {
    _id: id,
    // el contenido no cambió desde que lo leímos
    title: current.title,
    excerpt: current.excerpt,
    content: current.content,
    $or: [
      { "translations.en.status": { $ne: "pending" } },
      { "translations.en.startedAt": { $exists: false } },
      { "translations.en.startedAt": { $lt: new Date(now.getTime() - LOCK_TTL_MS) } },
    ],
  };
  if (!opts.force) filter.isPublished = true;
  if (nor.length) filter.$nor = nor;

  const claimed = await Article.findOneAndUpdate(
    filter,
    { $set: { "translations.en.status": "pending", "translations.en.startedAt": startedAt } },
    { new: true, projection: { _id: 1 }, timestamps: false }
  ).lean();

  if (!claimed) {
    const after = await Article.findById(id).select("title excerpt content translations").lean();
    const en = after?.translations?.en;
    if (after && isFullFresh(after, en)) return { status: "skipped", reason: "fresh" };
    if (isLockActive(en)) return { status: "skipped", reason: "locked" };
    return { status: "skipped", reason: "backoff" };
  }

  const owner = { _id: id, "translations.en.status": "pending", "translations.en.startedAt": startedAt };
  try {
    const t = await translateArticle(
      { title: current.title || "", excerpt: current.excerpt || "", content: current.content || "" },
      creds
    );
    await Article.updateOne(owner, {
      $set: {
        "translations.en.title": t.title,
        "translations.en.excerpt": t.excerpt,
        "translations.en.content": t.content,
        "translations.en.sourceHash": hash,
        "translations.en.summaryHash": hashSummary(current),
        "translations.en.status": "ready",
        "translations.en.model": t.model,
        "translations.en.translatedAt": new Date(),
      },
      $unset: { "translations.en.error": "", "translations.en.failedAt": "" },
    }, { timestamps: false });
    return { status: "ready", model: t.model };
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500);
    console.error(`[translation] ${id}: ${message}`);
    await Article.updateOne(owner, {
      $set: {
        "translations.en.status": "failed",
        "translations.en.error": message,
        "translations.en.failedAt": new Date(),
      },
    }, { timestamps: false }).catch(() => {});
    return { status: "failed", error: message };
  }
}

// Programa la traducción en segundo plano (acotado por instancia). Devuelve false si no se pudo.
export function scheduleTranslation(id: string, creds: LlmCredentials): boolean {
  if (!hasLlmCredentials(creds)) return false;
  if (activeJobs >= MAX_BACKGROUND_JOBS) return false;
  activeJobs++;
  runInBackground(async () => {
    try {
      await translateArticleNow(id, creds);
    } finally {
      activeJobs--;
    }
  }, "translation");
  return true;
}

// ¿Conviene lanzar una traducción automática para este artículo?
function needsAutoTranslation(doc: { title?: string; excerpt?: string; content?: string; translations?: { en?: EnTranslation } }) {
  const en = doc.translations?.en;
  if (isFullFresh(doc, en) || isLockActive(en) || isRecentlyFailed(en)) return false;
  return (doc.content || "").length <= MAX_CONTENT_CHARS;
}

// ---------------------------------------------------------------------------
// Detalle público (?lang=en)
// ---------------------------------------------------------------------------
export type PublicTranslationStatus = "ready" | "pending" | "unavailable";

export function resolveDetailTranslation(
  doc: { _id: unknown; title?: string; excerpt?: string; content?: string; translations?: { en?: EnTranslation } },
  creds: LlmCredentials
): { status: PublicTranslationStatus; en?: EnTranslation } {
  const en = doc.translations?.en;
  if (isFullFresh(doc, en)) return { status: "ready", en };
  if (isLockActive(en)) return { status: "pending" };
  if (!needsAutoTranslation(doc) || !hasLlmCredentials(creds)) return { status: "unavailable" };
  scheduleTranslation(String(doc._id), creds);
  return { status: "pending" };
}

// ---------------------------------------------------------------------------
// Listado público (?lang=en): títulos y extractos en un solo lote
// ---------------------------------------------------------------------------
type ListItem = Record<string, any> & { _id: unknown; title: string; excerpt: string; translations?: { en?: EnTranslation } };

export async function localizeListItems(items: ListItem[], creds: LlmCredentials): Promise<Record<string, unknown>[]> {
  const missing = items.filter((it) => !isSummaryFresh(it, it.translations?.en));
  const fresh = new Map<string, { title: string; excerpt: string }>();

  if (missing.length && hasLlmCredentials(creds) && Date.now() > summaryBackoffUntil) {
    try {
      const { results } = await translateSummaries(
        missing.map((it) => ({ id: String(it._id), title: it.title || "", excerpt: it.excerpt || "" })),
        creds,
        20_000
      );
      const ops: mongoose.AnyBulkWriteOperation[] = [];
      for (const it of missing) {
        const r = results.get(String(it._id));
        if (!r) continue;
        fresh.set(String(it._id), r);
        ops.push({
          updateOne: {
            // solo si el español no cambió mientras traducíamos
            filter: { _id: it._id, title: it.title, excerpt: it.excerpt },
            update: {
              $set: {
                "translations.en.title": r.title,
                "translations.en.excerpt": r.excerpt,
                "translations.en.summaryHash": hashSummary(it),
              },
            },
            timestamps: false,
          },
        });
      }
      if (ops.length) await Article.bulkWrite(ops as any, { ordered: false });
    } catch (err: any) {
      summaryBackoffUntil = Date.now() + SUMMARY_BACKOFF_MS;
      console.error("[translation] lote de resúmenes falló:", err?.message || err);
    }
  }

  // Traducciones completas en segundo plano para los artículos de la página (acotado)
  let scheduled = 0;
  for (const it of items) {
    if (scheduled >= MAX_SCHEDULED_PER_REQUEST) break;
    // El listado no trae content (no se puede calcular el hash completo): solo se programan
    // los que nunca se tradujeron o fallaron hace rato. Los desactualizados tras una edición
    // los cubre el guardado del admin y el cron del backlog.
    const en = it.translations?.en;
    if (en?.status === "ready" || isLockActive(en) || isRecentlyFailed(en)) continue;
    if (scheduleTranslation(String(it._id), creds)) scheduled++;
  }

  return items.map((it) => {
    const en = it.translations?.en;
    const { translations: _omit, ...rest } = it;
    const fromBatch = fresh.get(String(it._id));
    if (fromBatch) return { ...rest, title: fromBatch.title, excerpt: fromBatch.excerpt, lang: "en" };
    if (en && isSummaryFresh(it, en)) return { ...rest, title: en.title || rest.title, excerpt: en.excerpt ?? rest.excerpt, lang: "en" };
    return { ...rest, lang: "es" };
  });
}

// ---------------------------------------------------------------------------
// Backlog (admin y cron)
// ---------------------------------------------------------------------------
export async function processBacklog(limit: number, creds: LlmCredentials) {
  const docs = await Article.find({ isPublished: true })
    .select("slug date title excerpt content translations.en.status translations.en.sourceHash translations.en.title translations.en.startedAt translations.en.failedAt")
    .sort({ date: -1 })
    .lean();

  const needing = docs.filter((d) => !isFullFresh(d, d.translations?.en));
  const eligible = needing.filter((d) => {
    const en = d.translations?.en;
    return !isLockActive(en) && !isRecentlyFailed(en) && (d.content || "").length <= MAX_CONTENT_CHARS;
  });
  const batch = hasLlmCredentials(creds) ? eligible.slice(0, limit) : [];

  const results: { slug: string; status: string; error?: string }[] = [];
  const queue = [...batch];
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift()!;
      const r = await translateArticleNow(String(d._id), creds);
      results.push({
        slug: d.slug,
        status: r.status === "skipped" ? `skipped:${r.reason}` : r.status,
        ...(r.status === "failed" ? { error: r.error } : {}),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, batch.length) }, worker));

  const succeeded = results.filter((r) => r.status === "ready").length;
  const remaining = needing.length - succeeded;
  return {
    total: docs.length,
    translated: docs.length - remaining,
    remaining,
    processed: results.length,
    succeeded,
    failed: results.filter((r) => r.status === "failed").length,
    results,
    credentials: hasLlmCredentials(creds),
  };
}
