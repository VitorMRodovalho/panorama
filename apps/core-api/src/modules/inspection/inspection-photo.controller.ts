import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
// `Express.Multer.File` is declared by `@types/multer`; loaded via
// tsconfig.json `types: ["node", "multer"]`.
import { Throttle } from '@nestjs/throttler';
import {
  InspectionPhotoService,
  type PhotoActor,
  type PhotoViewKind,
} from './inspection-photo.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';

/**
 * Photo upload + GET-redirect surface (ADR-0012 §4 + §3).
 *
 *   POST   /inspections/:id/photos      multipart/form-data
 *                                       parts: photo (binary), clientUploadKey (uuid),
 *                                              responseId (uuid, optional)
 *   GET    /inspections/:id/photos/:photoId
 *                                       302 → presigned S3 GET
 *                                       ?view=list|detail (default detail)
 *
 * Multer cap is 10 MB — matches the documented infra-level limit.
 * Per-tenant + per-user Redis rate-limits live in the service.
 *
 * @Throttle is the in-memory belt (per-IP-per-process); the
 * authoritative cluster-wide cap is the Redis sliding window in the
 * PhotoUploadRateLimiter.
 */
@Controller('inspections/:id/photos')
export class InspectionPhotoController {
  constructor(private readonly photos: InspectionPhotoService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ upload: { ttl: 60_000, limit: 5 } })
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async upload(
    @Param('id') inspectionId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('clientUploadKey') clientUploadKey: string | undefined,
    @Body('responseId') responseId: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    if (!file) throw new BadRequestException('photo_part_required');
    if (!clientUploadKey) throw new BadRequestException('clientUploadKey_required');
    if (file.size === 0) throw new BadRequestException('empty_photo');
    if (file.size > 10 * 1024 * 1024) {
      throw new PayloadTooLargeException('photo_too_large');
    }

    const actor = this.actorFromSession(req);
    const result = await this.photos.upload(actor, inspectionId, {
      buffer: file.buffer,
      originalFilename: file.originalname,
      clientUploadKey,
      ...(responseId ? { responseId } : {}),
    });
    return {
      id: result.photo.id,
      inspectionId: result.photo.inspectionId,
      sha256: result.photo.sha256,
      width: result.photo.width,
      height: result.photo.height,
      sizeBytes: result.photo.sizeBytes,
      capturedAt: result.photo.capturedAt,
      uploadedAt: result.photo.uploadedAt,
      signedUrl: result.signedUrl,
      deduped: result.deduped,
    };
  }

  @Get(':photoId')
  async view(
    @Param('id') inspectionId: string,
    @Param('photoId') photoId: string,
    @Query('view') viewParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const actor = this.actorFromSession(req);
    const viewKind: PhotoViewKind = viewParam === 'list' ? 'list' : 'detail';
    const url = await this.photos.getSignedUrlForView(
      actor,
      inspectionId,
      photoId,
      viewKind,
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, url);
  }

  private actorFromSession(req: Request): PhotoActor {
    const session = requireSession(req);
    const out: PhotoActor = {
      tenantId: session.currentTenantId,
      userId: session.userId,
      role: session.currentRole,
    };
    const ip = req.ip;
    if (ip) out.ipAddress = ip;
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') out.userAgent = ua;
    return out;
  }
}

function requireSession(req: Request): PanoramaSession {
  const s = getRequestSession(req);
  if (!s) throw new UnauthorizedException('authentication_required');
  return s;
}
