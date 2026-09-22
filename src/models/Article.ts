import mongoose, { Schema, Document } from "mongoose";
import { EnTranslation } from "../utils/translation.helpers";

export interface IArticle extends Document {
  wpId: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  date: Date;
  featuredImage: string;
  sourceUrl: string;
  categories: string[];
  tags: string[];
  source: string; // "drjuangarza" | "phb"
  isPublished: boolean;
  // Traducciones automáticas generadas a partir del texto en español (nunca se editan a mano).
  translations?: { en?: EnTranslation };
  createdAt: Date;
  updatedAt: Date;
}

// Traducción al inglés embebida en el mismo documento (no se duplica el artículo).
const EnTranslationSchema = new Schema(
  {
    title: { type: String, default: "" },
    excerpt: { type: String, default: "" },
    content: { type: String, default: "" },
    sourceHash: { type: String, default: "" },
    summaryHash: { type: String, default: "" },
    status: { type: String, enum: ["ready", "pending", "failed"] },
    model: { type: String, default: "" },
    translatedAt: { type: Date },
    error: { type: String },
    startedAt: { type: Date },
    failedAt: { type: Date },
  },
  { _id: false }
);

const ArticleSchema = new Schema<IArticle>(
  {
    wpId: { type: Number, default: 0 },
    slug: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    excerpt: { type: String, default: "" },
    content: { type: String, default: "" },
    date: { type: Date, required: true },
    featuredImage: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    categories: [{ type: String }],
    tags: [{ type: String }],
    source: { type: String, default: "drjuangarza", enum: ["drjuangarza", "phb"] },
    isPublished: { type: Boolean, default: true },
    translations: {
      type: new Schema(
        {
          en: { type: EnTranslationSchema, default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  {
    timestamps: true,
    collection: "articles",
  }
);

ArticleSchema.index({ date: -1 });
ArticleSchema.index({ source: 1, isPublished: 1 });
ArticleSchema.index({ title: "text", excerpt: "text" });

export const Article = mongoose.model<IArticle>("Article", ArticleSchema);
