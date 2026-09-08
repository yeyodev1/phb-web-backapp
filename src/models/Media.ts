import mongoose, { Schema, Document } from "mongoose";

// Almacena imágenes de portada cuando no hay un CDN externo configurado.
// Se sirven vía GET /api/media/:id con caché inmutable.
export interface IMedia extends Document {
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;
  createdAt: Date;
}

const MediaSchema = new Schema<IMedia>(
  {
    filename: { type: String, default: "" },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "media" }
);

export const Media = mongoose.model<IMedia>("Media", MediaSchema);
