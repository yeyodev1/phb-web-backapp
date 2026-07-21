/**
 * Seed script — loads all articles from drjuangarza.net WP REST API into MongoDB.
 * Run with:  npx ts-node src/scripts/seedArticles.ts
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import axios from "axios";
import { Article } from "../models/Article";

const WP_BASE = "https://drjuangarza.net/wp-json/wp/v2/posts";
const FIELDS = "id,slug,title,date,excerpt,content,featured_media,_links";

async function fetchPage(page: number): Promise<{ posts: WpPost[]; totalPages: number }> {
  const { data, headers } = await axios.get<WpPost[]>(WP_BASE, {
    params: {
      per_page: 100,
      page,
      _fields: FIELDS,
      orderby: "date",
      order: "desc",
    },
  });
  const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
  return { posts: data, totalPages };
}

interface WpPost {
  id: number;
  slug: string;
  title: { rendered: string };
  date: string;
  excerpt: { rendered: string };
  content: { rendered: string };
  featured_media: number;
  _links?: { "wp:featuredmedia"?: [{ href: string }] };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, "\u201c")
    .replace(/&#8221;/g, "\u201d")
    .replace(/&#8230;/g, "…")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ");
}

async function fetchFeaturedImage(mediaId: number): Promise<string> {
  if (!mediaId) return "";
  try {
    const { data } = await axios.get(
      `https://drjuangarza.net/wp-json/wp/v2/media/${mediaId}`,
      { params: { _fields: "source_url" }, timeout: 5000 }
    );
    return data.source_url || "";
  } catch {
    return "";
  }
}

async function seed() {
  const DB_URI = process.env.DB_URI;
  if (!DB_URI) throw new Error("DB_URI not set in .env");

  await mongoose.connect(DB_URI);
  console.log("Connected to MongoDB");

  // Get total pages first
  const { posts: firstPage, totalPages } = await fetchPage(1);
  console.log(`Total pages: ${totalPages}`);

  let allPosts: WpPost[] = [...firstPage];

  // Fetch remaining pages
  for (let p = 2; p <= totalPages; p++) {
    console.log(`Fetching page ${p}/${totalPages}...`);
    const { posts } = await fetchPage(p);
    allPosts = [...allPosts, ...posts];
    await new Promise((r) => setTimeout(r, 300)); // polite delay
  }

  console.log(`Total posts fetched: ${allPosts.length}`);

  let inserted = 0;
  let skipped = 0;

  for (const post of allPosts) {
    const slug = post.slug;
    const exists = await Article.findOne({ slug });
    if (exists) {
      skipped++;
      continue;
    }

    // Fetch featured image if available
    let featuredImage = "";
    if (post.featured_media) {
      featuredImage = await fetchFeaturedImage(post.featured_media);
    }

    await Article.create({
      wpId: post.id,
      slug,
      title: decodeEntities(post.title.rendered),
      excerpt: stripHtml(decodeEntities(post.excerpt.rendered)).substring(0, 400),
      content: post.content.rendered,
      date: new Date(post.date),
      featuredImage,
      sourceUrl: `https://drjuangarza.net/${slug}/`,
      categories: [],
      tags: [],
      source: "drjuangarza",
      isPublished: true,
    });

    inserted++;
    if (inserted % 10 === 0) {
      console.log(`Progress: ${inserted} inserted, ${skipped} skipped...`);
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\nDone! Inserted: ${inserted}, Skipped (already exist): ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
