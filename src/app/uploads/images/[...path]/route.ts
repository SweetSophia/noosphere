import { NextRequest, NextResponse } from "next/server";
import { readUploadedImage } from "@/lib/uploads";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await context.params;
    const image = await readUploadedImage(path);

    return new NextResponse(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[GET /uploads/images]", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
