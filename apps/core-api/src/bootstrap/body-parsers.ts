import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Register the JSON and urlencoded body parsers with `inflate: false`.
 *
 * Nest's defaults (`express.json()` and `express.urlencoded({ extended: true })`)
 * accept `Content-Encoding: gzip | deflate | br` and decompress the body before any
 * guard runs, so an anonymous client gets the server to inflate whatever it sends.
 * That is the path CVE-2026-111497 (Node's Brotli decoder) was reachable through
 * on a bare Express app. No Panorama client compresses request bodies, so the
 * parsers refuse them: a compressed body is answered 415 and never decoded.
 *
 * Call this after `NestFactory.create(AppModule, { bodyParser: false })`; the
 * options are otherwise Nest's own defaults (100kb limit, extended urlencoded).
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { inflate: false });
  app.useBodyParser('urlencoded', { extended: true, inflate: false });
}
