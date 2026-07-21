import mongoose, { Schema, Document } from "mongoose";

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
  createdAt: Date;
  updatedAt: Date;
}

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
