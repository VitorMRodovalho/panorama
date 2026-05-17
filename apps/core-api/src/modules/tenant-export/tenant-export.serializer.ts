import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * ADR-0020 §8 — collect every tenant-scoped row into a single
 * exportable JSON document.
 *
 * Shape:
 *   {
 *     "panoramaExport": { "version": 1, "tenantId": "<uuid>", "generatedAt": "<iso>" },
 *     "tables": {
 *       "tenants":           [...],
 *       "tenant_memberships":[...],
 *       "users":             [...],   // only Users with membership in this tenant
 *       ...
 *     }
 *   }
 *
 * Tables omitted from PR 4 (follow-up):
 *   - inspection_photos / maintenance_photos — the binary lives in
 *     S3; including the binary blob in the JSON document would
 *     bloat the export for tenants with many photos. A future PR
 *     adds a side-car manifest with presigned download URLs per
 *     photo.
 *   - personal_access_tokens — secret material; ADR-0020 §8 doesn't
 *     mandate including, and exporting the hashes provides no
 *     operator value.
 *   - audit_events — large + already accessible by tenant admins
 *     via existing surfaces. Inclusion deferred to a follow-up that
 *     decides on chain-strand windowing.
 *
 * The list is intentionally lower-bound MVP — operators can extend
 * the serializer as LGPD / audit demand evolves. New tenant-scoped
 * tables MUST add a query here (the test asserts presence of the
 * core set).
 */

export interface SerializedExport {
  panoramaExport: {
    version: number;
    tenantId: string;
    generatedAt: string;
  };
  tables: Record<string, unknown[]>;
}

const SCHEMA_VERSION = 1;

/**
 * Build the in-memory export document. Uses a transaction client
 * so all queries observe a consistent snapshot of the tenant's data.
 */
export async function serializeTenantExport(
  tx: Prisma.TransactionClient,
  tenantId: string,
  log?: Logger,
): Promise<SerializedExport> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new Error(`tenant_not_found_for_export:${tenantId}`);
  }

  const memberships = await tx.tenantMembership.findMany({
    where: { tenantId },
  });
  const userIds = Array.from(new Set(memberships.map((m) => m.userId)));
  // Resolve User rows belonging to this tenant's memberships. Other
  // multi-tenant users are NOT included — they're not "the tenant's
  // data" in any LGPD-meaningful sense.
  const users = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      email: true,
      displayName: true,
      firstName: true,
      lastName: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const categories = await tx.category.findMany({ where: { tenantId } });
  const manufacturers = await tx.manufacturer.findMany({ where: { tenantId } });
  const assetModels = await tx.assetModel.findMany({ where: { tenantId } });
  const assets = await tx.asset.findMany({ where: { tenantId } });
  const reservations = await tx.reservation.findMany({ where: { tenantId } });
  const blackoutSlots = await tx.blackoutSlot.findMany({ where: { tenantId } });
  // Explicit select-list EXCLUDES `tokenHash` — sha256 of a still-
  // redeemable invitation token is credential-shaped material that
  // must never ride into a user-downloadable artefact (security-
  // reviewer PR 4 BLOCKER 2). Same discipline applies to any future
  // hash/secret column added under a tenant.
  const invitations = await tx.invitation.findMany({
    where: { tenantId },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      targetUserId: true,
      invitedByUserId: true,
      expiresAt: true,
      acceptedAt: true,
      acceptedByUserId: true,
      revokedAt: true,
      revokedByUserId: true,
      emailQueuedAt: true,
      emailSentAt: true,
      emailBouncedAt: true,
      emailAttempts: true,
      emailLastError: true,
      createdAt: true,
    },
  });
  const inspectionTemplates = await tx.inspectionTemplate.findMany({
    where: { tenantId },
  });
  const inspectionTemplateItems = await tx.inspectionTemplateItem.findMany({
    where: { tenantId },
  });
  const inspections = await tx.inspection.findMany({ where: { tenantId } });
  const inspectionResponses = await tx.inspectionResponse.findMany({
    where: { tenantId },
  });
  const assetMaintenances = await tx.assetMaintenance.findMany({
    where: { tenantId },
  });

  log?.debug?.(
    {
      tenantId,
      counts: {
        memberships: memberships.length,
        users: users.length,
        assets: assets.length,
        reservations: reservations.length,
        inspections: inspections.length,
        assetMaintenances: assetMaintenances.length,
      },
    },
    'tenant_export_serialized',
  );

  return {
    panoramaExport: {
      version: SCHEMA_VERSION,
      tenantId,
      generatedAt: new Date().toISOString(),
    },
    tables: {
      tenants: [tenant],
      tenant_memberships: memberships,
      users,
      categories,
      manufacturers,
      asset_models: assetModels,
      assets,
      reservations,
      blackout_slots: blackoutSlots,
      invitations,
      inspection_templates: inspectionTemplates,
      inspection_template_items: inspectionTemplateItems,
      inspections,
      inspection_responses: inspectionResponses,
      asset_maintenances: assetMaintenances,
    },
  };
}

/**
 * BigInt safe JSON serialization — Prisma returns some columns as
 * JS BigInt (e.g. `objectSizeBytes`), and `JSON.stringify` throws on
 * BigInt by default. We coerce them to strings (lossless for
 * 2^53+ values) using a replacer.
 */
export function exportToJsonString(doc: SerializedExport): string {
  return JSON.stringify(doc, (_, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
