import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// XHR-driven photo upload from the client uploader (UX-22 / #46) hits this
// route — same-origin so the session cookie travels without CORS, and we
// can stream the multipart body straight through to the core-api without
// reading it into memory. Returns JSON rather than redirecting so the
// client can render progress, cancel, and retry states.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const inspectionId = id.trim();
  if (!inspectionId) {
    return NextResponse.json({ message: 'missing_inspection_id' }, { status: 400 });
  }

  const upstream = await fetch(`${CORE_API}/inspections/${inspectionId}/photos`, {
    method: 'POST',
    headers: {
      cookie: await cookieHeader(),
      ...(req.headers.get('content-type')
        ? { 'content-type': req.headers.get('content-type')! }
        : {}),
    },
    body: req.body,
    // @ts-expect-error — duplex is required when streaming a request body
    // through the Next.js server runtime; the type is missing from
    // lib.dom.d.ts as of 2026-04. https://github.com/whatwg/fetch/pull/1457
    duplex: 'half',
    cache: 'no-store',
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': contentType },
  });
}
