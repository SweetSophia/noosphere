import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireApiKey } from "@/lib/api/keys";
import { saveUploadedImage } from "@/lib/uploads";

const MAX_FILE_SIZE = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (apiAuth.authorized && !["WRITE", "ADMIN"].includes(apiAuth.permissions)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  if (session?.user && !["EDITOR", "ADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const alt = String(formData.get("alt") ?? "").replace(/<[^>]*>/g, "").trim() || "image";

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
