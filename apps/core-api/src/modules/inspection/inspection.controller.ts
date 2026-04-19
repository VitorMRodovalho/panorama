import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CancelInspectionSchema,
  CompleteInspectionSchema,
  ListInspectionsSchema,
  RespondBatchSchema,
  ReviewInspectionSchema,
  ReviewNoteUpdateSchema,
  StartInspectionSchema,
} from './inspection.dto.js';
import {
  InspectionService,
  type InspectionActor,
} from './inspection.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';

/**
 * Inspection lifecycle HTTP surface (ADR-0012 §Execution-order step 7b).
 *
 * Auth model:
 *   - GET (list/get): driver sees only `scope=mine`; admin can ask
 *     for `scope=tenant`.
 *   - POST start / responses / complete / cancel: starter or admin.
 *   - POST review / PATCH reviewNote: admin only (enforced in service).
 *
 * Photo upload (POST :id/photos) lives in step 7c's controller.
 */
@Controller('inspections')
export class InspectionController {
  constructor(private readonly inspections: InspectionService) {}

  @Post()
  @HttpCode(201)
  async start(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = StartInspectionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const result = await this.inspections.start(actor, parsed.data);
    // 200 + resumed=true vs 201 + resumed=false would be more REST,
    // but a single 201 with `resumed` in the body is friendlier for
    // the launcher UI which doesn't care about the distinction.
    return { ...this.shape(result.inspection), resumed: result.resumed };
  }

  @Post(':id/responses')
  @HttpCode(200)
  async respond(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ count: number }> {
    const actor = this.actorFromSession(req);
    const parsed = RespondBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    return this.inspections.respond(actor, id, parsed.data);
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = CompleteInspectionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const insp = await this.inspections.complete(actor, id, parsed.data);
    return this.shape(insp);
  }

  @Post(':id/review')
  @HttpCode(200)
  async review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ReviewInspectionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const insp = await this.inspections.review(actor, id, parsed.data);
    return this.shape(insp);
  }

  @Patch(':id/review-note')
  @HttpCode(200)
  async updateReviewNote(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ReviewNoteUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const insp = await this.inspections.updateReviewNote(actor, id, parsed.data);
    return this.shape(insp);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = CancelInspectionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const insp = await this.inspections.cancel(actor, id, parsed.data);
    return this.shape(insp);
  }

  @Get()
  async list(
    @Query('scope') scope: string | undefined,
    @Query('status') status: string | undefined,
    @Query('outcome') outcome: string | undefined,
    @Query('needsReview') needsReview: string | undefined,
    @Query('assetId') assetId: string | undefined,
    @Query('reservationId') reservationId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: unknown[] }> {
    const actor = this.actorFromSession(req);
    const parsed = ListInspectionsSchema.safeParse({
      scope,
      status,
      outcome,
      needsReview,
      assetId,
      reservationId,
      limit,
    });
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const items = await this.inspections.list(actor, parsed.data);
    return { items: items.map((r) => this.shape(r)) };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const insp = await this.inspections.get(actor, id);
    // Include the snapshot in the get response — the form UI reads
    // it to render the items.
    return { ...this.shape(insp), templateSnapshot: insp.templateSnapshot };
  }

  // ----------------------------------------------------------------

  private actorFromSession(req: Request): InspectionActor {
    const session = requireSession(req);
    return {
      tenantId: session.currentTenantId,
      userId: session.userId,
      role: session.currentRole,
    };
  }

  private shape(insp: {
    id: string;
    tenantId: string;
    templateId: string | null;
    assetId: string;
    reservationId: string | null;
    startedByUserId: string;
    status: string;
    outcome: string | null;
    summaryNote: string | null;
    startedAt: Date;
    completedAt: Date | null;
    completedByUserId: string | null;
    reviewedAt: Date | null;
    reviewedByUserId: string | null;
    reviewNote: string | null;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      id: insp.id,
      tenantId: insp.tenantId,
      templateId: insp.templateId,
      assetId: insp.assetId,
      reservationId: insp.reservationId,
      startedByUserId: insp.startedByUserId,
      status: insp.status,
      outcome: insp.outcome,
      summaryNote: insp.summaryNote,
      startedAt: insp.startedAt,
      completedAt: insp.completedAt,
      completedByUserId: insp.completedByUserId,
      reviewedAt: insp.reviewedAt,
      reviewedByUserId: insp.reviewedByUserId,
      reviewNote: insp.reviewNote,
      createdAt: insp.createdAt,
    };
  }
}

function requireSession(req: Request): PanoramaSession {
  const s = getRequestSession(req);
  if (!s) throw new UnauthorizedException('authentication_required');
  return s;
}
