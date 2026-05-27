import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { saveUploadedImage } from "@/lib/uploads";
import { rateLimit } from "@/lib/rate-limit";

const MAX_FILE_SIZE = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "upload" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    // Sanitize alt text: strip all HTML tags (case-insensitive) and reject JS patterns
    const rawAlt = String(formData.get("alt") ?? "").trim();
    if (/on\w+\s*=|javascript:/i.test(rawAlt)) {
      return NextResponse.json({ error: "Alt text contains disallowed patterns" }, { status: 400 });
    }
    const alt = rawAlt.replace(/<[^>]*>/gi, "").trim() || "image";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No image uploaded" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Image must be 5MB or smaller" }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await saveUploadedImage(file.name, bytes);

    return NextResponse.json({
      filename: saved.filename,
      url: saved.publicUrl,
      markdown: `![${alt}](${saved.publicUrl})`,
      size: file.size,
      extension: path.extname(saved.filename).toLowerCase(),
    });
  } catch (error) {
    console.error("[POST /api/uploads/image]", error);
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
