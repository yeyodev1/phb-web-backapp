import { Request } from "express";
import mongoose from "mongoose";
import { Article } from "../models/Article";
import { runInBackground } from "../utils/background";
import {
  EnTranslation,
  LOCK_TTL_MS,
  SUMMARY_BACKOFF_MS,
  SUMMARY_LOCK_MS,
  adminTranslationState,
  canTranslateSummary,
  hashSource,
  hashSummary,
  isFullFresh,
  isLockActive,
  isRetryBlocked,
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
const MAX_SYNC_SUMMARIES = 12; // títulos/extractos traducidos en línea por petición del listado

let activeJobs = 0;

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
  | { status: "skipped"; reason: "fresh" | "locked" | "backoff" | "changed" | "not-found" };

// Reclama el artículo (status=pending, attempts+1) de forma atómica y lo traduce.
// - Nunca traduce dos veces el mismo hash (si ya está listo y fresco no se reclama).
// - Si otro proceso lo tiene reclamado hace menos de 5 min, no hace nada.
// - Sin force respeta el backoff exponencial y el tope de intentos (isRetryBlocked).
// - force: permite borradores, ignora el backoff/tope y regenera aunque esté fresco.
// - Si el español cambió mientras se traducía, programa otra pasada con el texto nuevo.
export async function translateArticleNow(
  id: string,
  creds: LlmCredentials,
  opts: { force?: boolean } = {}
): Promise<TranslateOutcome> {
  const current = await Article.findById(id)
    .select("title excerpt content isPublished translations.en.status translations.en.title translations.en.sourceHash translations.en.startedAt translations.en.failedAt translations.en.attempts")
    .lean();
  if (!current || (!opts.force && !current.isPublished)) return { status: "skipped", reason: "not-found" };

  const prev = current.translations?.en;
  const hash = hashSource(current);
  if (isLockActive(prev)) return { status: "skipped", reason: "locked" };
  if (!opts.force) {
    if (isFullFresh(current, prev)) return { status: "skipped", reason: "fresh" };
    if (isRetryBlocked(prev)) return { status: "skipped", reason: "backoff" };
  }

  const now = new Date();
  const startedAt = now;
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
  if (!opts.force) {
    filter.isPublished = true;
    // nadie más lo intentó desde que lo leímos (control optimista sobre el contador)
    filter["translations.en.attempts"] = prev?.attempts ? prev.attempts : { $in: [null, 0] };
    filter.$nor = [{ "translations.en.status": "ready", "translations.en.sourceHash": hash }];
  }

  const claimed = await Article.findOneAndUpdate(
    filter,
    {
      $set: { "translations.en.status": "pending", "translations.en.startedAt": startedAt },
      $inc: { "translations.en.attempts": 1 },
    },
    { new: true, projection: { _id: 1 }, timestamps: false }
  ).lean();

  if (!claimed) {
    const after = await Article.findById(id).select("title excerpt content translations").lean();
    if (!after) return { status: "skipped", reason: "not-found" };
    const en = after.translations?.en;
    if (isLockActive(en)) return { status: "skipped", reason: "locked" };
    if (hashSource(after) !== hash) return { status: "skipped", reason: "changed" };
    if (isFullFresh(after, en)) return { status: "skipped", reason: "fresh" };
    return { status: "skipped", reason: "backoff" };
  }

  const owner = { _id: id, "translations.en.status": "pending", "translations.en.startedAt": startedAt };
  // ¿Había ya una traducción válida para este mismo texto? (regeneración forzada)
  const hadValid = !!prev?.title && !!prev?.sourceHash && prev.sourceHash === hash && prev.status !== "failed";
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
        "translations.en.attempts": 0,
      },
      $unset: {
        "translations.en.error": "",
        "translations.en.failedAt": "",
        "translations.en.summaryFailedAt": "",
        "translations.en.summaryPendingAt": "",
      },
    }, { timestamps: false });
    await followUpIfChanged(id, hash, creds);
    return { status: "ready", model: t.model };
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500);
    console.error(`[translation] ${id}: ${message}`);
    await Article.updateOne(owner, {
      $set: hadValid
        ? {
            // la traducción anterior sigue siendo válida para este texto: se conserva
            "translations.en.status": "ready",
            "translations.en.error": message,
            "translations.en.failedAt": new Date(),
            "translations.en.attempts": 0,
          }
        : {
            "translations.en.status": "failed",
            "translations.en.error": message,
            "translations.en.failedAt": new Date(),
          },
    }, { timestamps: false }).catch(() => {});
    return { status: "failed", error: message };
  }
}

// Si el admin guardó otra versión mientras traducíamos (su propio trabajo se topó con el
// bloqueo), la traducción recién escrita ya nace desactualizada: se lanza otra pasada.
async function followUpIfChanged(id: string, translatedHash: string, creds: LlmCredentials) {
  try {
    const latest = await Article.findById(id).select("title excerpt content isPublished").lean();
    if (latest?.isPublished && hashSource(latest) !== translatedHash) {
      scheduleTranslation(id, creds, { followUp: true });
    }
  } catch {
    // el cron del backlog lo recogerá
  }
}

// Programa la traducción en segundo plano (acotado por instancia). Devuelve false si no se pudo.
// Las pasadas de seguimiento (followUp) no cuentan contra el tope: son como mucho una por trabajo.
export function scheduleTranslation(id: string, creds: LlmCredentials, opts: { followUp?: boolean } = {}): boolean {
  if (!hasLlmCredentials(creds)) return false;
  if (!opts.followUp && activeJobs >= MAX_BACKGROUND_JOBS) return false;
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
  if (isFullFresh(doc, en) || isLockActive(en) || isRetryBlocked(en)) return false;
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
  const fresh = new Map<string, { title: string; excerpt: string }>();
  // Solo los que no están frescos, no están en curso ni fallaron hace poco (estado en la base,
  // compartido entre instancias), y como mucho MAX_SYNC_SUMMARIES por petición.
  const candidates = hasLlmCredentials(creds)
    ? items
        .filter((it) => !isSummaryFresh(it, it.translations?.en) && canTranslateSummary(it.translations?.en))
        .slice(0, MAX_SYNC_SUMMARIES)
    : [];

  if (candidates.length) {
    const now = new Date();
    // Reclamo atómico por artículo: peticiones concurrentes no pagan dos veces el mismo resumen
    const flags = await Promise.all(
      candidates.map((it) =>
        Article.updateOne(
          {
            _id: it._id,
            title: it.title,
            excerpt: it.excerpt,
            $and: [
              {
                $or: [
                  { "translations.en.summaryPendingAt": null },
                  { "translations.en.summaryPendingAt": { $lt: new Date(now.getTime() - SUMMARY_LOCK_MS) } },
                ],
              },
              {
                $or: [
                  { "translations.en.summaryFailedAt": null },
                  { "translations.en.summaryFailedAt": { $lt: new Date(now.getTime() - SUMMARY_BACKOFF_MS) } },
                ],
              },
            ],
          },
          { $set: { "translations.en.summaryPendingAt": now } },
          { timestamps: false }
        )
          .then((r) => r.modifiedCount === 1)
          .catch(() => false)
      )
    );
    const claimed = candidates.filter((_, i) => flags[i]);

    if (claimed.length) {
      let results = new Map<string, { title: string; excerpt: string }>();
      try {
        ({ results } = await translateSummaries(
          claimed.map((it) => ({ id: String(it._id), title: it.title || "", excerpt: it.excerpt || "" })),
          creds,
          20_000
        ));
      } catch (err: any) {
        console.error("[translation] lote de resúmenes falló:", err?.message || err);
      }
      const ops: mongoose.AnyBulkWriteOperation[] = [];
      for (const it of claimed) {
        const r = results.get(String(it._id));
        if (r) {
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
                $unset: { "translations.en.summaryPendingAt": "", "translations.en.summaryFailedAt": "" },
              },
              timestamps: false,
            },
          });
        } else {
          // falló el lote o el ítem vino mal: backoff en la base para no volver a pagarlo en cada visita
          ops.push({
            updateOne: {
              filter: { _id: it._id, "translations.en.summaryPendingAt": now },
              update: {
                $set: { "translations.en.summaryFailedAt": new Date() },
                $unset: { "translations.en.summaryPendingAt": "" },
              },
              timestamps: false,
            },
          });
        }
      }
      if (ops.length) await Article.bulkWrite(ops as any, { ordered: false }).catch((e) => console.error("[translation] bulkWrite:", e?.message || e));
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
    if (en?.status === "ready" || isLockActive(en) || isRetryBlocked(en)) continue;
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
    .select("slug date title excerpt content translations.en.status translations.en.sourceHash translations.en.title translations.en.startedAt translations.en.failedAt translations.en.attempts")
    .sort({ date: -1 })
    .lean();

  const needing = docs.filter((d) => !isFullFresh(d, d.translations?.en));
  const eligible = needing.filter((d) => {
    const en = d.translations?.en;
    return !isLockActive(en) && !isRetryBlocked(en) && (d.content || "").length <= MAX_CONTENT_CHARS;
  });
  // Primero los que nunca se intentaron; los que ya fallaron van al final (sort estable: dentro
  // de cada grupo se mantiene el orden por fecha) para que no bloqueen el avance del backlog.
  eligible.sort((x, y) => (x.translations?.en?.attempts || 0) - (y.translations?.en?.attempts || 0));
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
