import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Dynamic import to catch Prisma initialization errors
    const { prisma } = await import("@/lib/prisma");

    // Verify database connectivity
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (error) {
    // Sanitized error logging - only log message/code, not full error object
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[Health check] Database unavailable:", errorMessage);
    return NextResponse.json(
      { status: "error", timestamp: new Date().toISOString() },
      { status: 503 }
    );
  }
}
