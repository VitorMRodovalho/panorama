import { Injectable, Logger } from '@nestjs/common';
import {
  FIXTURE_FILES,
  IMPORT_ORDER,
  ManifestSchema,
  TenantFixtureSchema,
  UserFixtureSchema,
  TenantMembershipFixtureSchema,
  CategoryFixtureSchema,
  ManufacturerFixtureSchema,
  AssetModelFixtureSchema,
  AssetFixtureSchema,
  type Manifest,
  type FixtureSource,
} from '@panorama/shared';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Prisma, CategoryKind, AssetStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ImportOptions {
  dir: string;
  dryRun?: boolean;
}

export interface ImportResult {
  source: FixtureSource;
  dryRun: boolean;
  counts: Record<string, { created: number; matched: number }>;
  errors: string[];
}

const IDENTITY_MAP_ENTITY = {
  tenants: 'tenant',
  users: 'user',
  tenantMemberships: 'tenant_membership',
  categories: 'category',
  manufacturers: 'manufacturer',
  assetModels: 'asset_model',
  assets: 'asset',
} as const;

@Injectable()
export class ImportService {
  private readonly log = new Logger('ImportService');

  constructor(private readonly prisma: PrismaService) {}

  async run(opts: ImportOptions): Promise<ImportResult> {
    const manifest = await this.readManifest(opts.dir);
    this.log.log({ manifest, opts }, 'import_start');

    const result: ImportResult = {
      source: manifest.source,
      dryRun: !!opts.dryRun,
      counts: {},
      errors: [],
    };

    // Cross-tenant import path. We explicitly do NOT open a runInTenant
    // transaction — the fixtures span tenants by design (super-admin flow).
    // Each entity type gets its own transaction so a failure in the middle
    // rolls back only that batch, not the whole import.
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        for (const entity of IMPORT_ORDER) {
          const count = await this.runEntity(tx, manifest.source, entity, opts);
          result.counts[entity] = count;
        }
      },
      { reason: `import-fixtures from ${opts.dir}` },
    );

    // ADR-0007: every tenant must land with ≥1 active Owner. If the
    // source fixtures don't elect one (e.g. Snipe-IT group mapping
    // that never marks anyone as "owner"), surface the problem as a
    // non-fatal warning in `errors` so the operator can rerun the
    // break-glass CLI. We deliberately don't auto-elect an Owner —
    // the ADR puts that decision on a human.
    const orphaned = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenants = await tx.tenant.findMany({ select: { id: true, slug: true } });
        const offenders: string[] = [];
        for (const t of tenants) {
          const owners = await tx.tenantMembership.count({
            where: { tenantId: t.id, role: 'owner', status: 'active' },
          });
          if (owners === 0) offenders.push(t.slug);
        }
        return offenders;
      },
      { reason: 'import:owner-invariant-check' },
    );
    for (const slug of orphaned) {
      const msg = `tenant_has_no_active_owner:${slug}`;
      result.errors.push(msg);
      this.log.warn({ slug }, 'tenant_has_no_active_owner');
    }

    this.log.log({ counts: result.counts, orphaned: orphaned.length }, 'import_done');
    return result;
  }

  // ---------------------------------------------------------------------
  // Entity dispatch
  // ---------------------------------------------------------------------

  private async runEntity(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    entity: Exclude<keyof typeof FIXTURE_FILES, 'manifest'>,
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    const file = FIXTURE_FILES[entity];
    const rawRows = await this.readFixture(opts.dir, file);
    if (rawRows === null) {
      this.log.debug({ entity, file }, 'fixture_file_missing_skipping');
      return { created: 0, matched: 0 };
    }

    switch (entity) {
      case 'tenants':
        return this.importTenants(tx, source, rawRows, opts);
      case 'users':
        return this.importUsers(tx, source, rawRows, opts);
      case 'tenantMemberships':
        return this.importTenantMemberships(tx, source, rawRows, opts);
      case 'categories':
        return this.importCategories(tx, source, rawRows, opts);
      case 'manufacturers':
        return this.importManufacturers(tx, source, rawRows, opts);
      case 'assetModels':
        return this.importAssetModels(tx, source, rawRows, opts);
      case 'assets':
        return this.importAssets(tx, source, rawRows, opts);
    }
  }

  // ---------------------------------------------------------------------
  // Per-entity importers — all idempotent via import_identity_map lookup.
  // ---------------------------------------------------------------------

  private async importTenants(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = TenantFixtureSchema.parse(raw);
      const existing = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceId,
      );
      if (existing) {
        matched++;
        continue;
      }
      if (opts.dryRun) {
        created++;
        continue;
      }
      // ADR-0016 §1 — system user per tenant for auto-suggested
      // maintenance audit attribution.
      const systemUser = await tx.user.create({
        data: {
          email: `system+${fixture.slug}-${Date.now()}@panorama.invalid`,
          displayName: `${fixture.slug} System`,
          status: 'ACTIVE',
        },
      });
      const tenant = await tx.tenant.create({
        data: {
          slug: fixture.slug,
          name: fixture.name,
          displayName: fixture.displayName,
          locale: fixture.locale,
          timezone: fixture.timezone,
          systemActorUserId: systemUser.id,
        },
      });
      await tx.tenantMembership.create({
        data: {
          tenantId: tenant.id,
          userId: systemUser.id,
          role: 'system',
          status: 'active',
        },
      });
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceId,
        tenant.id,
      );
      created++;
    }
    return { created, matched };
  }

  private async importUsers(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = UserFixtureSchema.parse(raw);

      // Users are globally unique by email. If the mapping already exists, reuse.
      const existingMap = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.users,
        fixture.sourceId,
      );
      if (existingMap) {
        matched++;
        continue;
      }

      // Otherwise: email-dedupe against the global users table. Two tenants
      // may migrate the same person; they share one User with two memberships.
      const existingUser = await tx.user.findUnique({ where: { email: fixture.email } });

      if (opts.dryRun) {
        created++;
        continue;
      }

      let userId: string;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const user = await tx.user.create({
          data: {
            email: fixture.email,
            displayName: fixture.displayName,
            firstName: fixture.firstName ?? null,
            lastName: fixture.lastName ?? null,
          },
        });
        userId = user.id;
      }
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.users,
        fixture.sourceId,
        userId,
      );
      created++;
    }
    return { created, matched };
  }

  private async importTenantMemberships(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = TenantMembershipFixtureSchema.parse(raw);
      const tenantId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceTenantId,
      );
      const userId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.users,
        fixture.sourceUserId,
      );

      const existing = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
      });
      if (existing) {
        matched++;
        continue;
      }
      if (opts.dryRun) {
        created++;
        continue;
      }
      await tx.tenantMembership.create({
        data: {
          tenantId,
          userId,
          role: fixture.role,
          isVip: fixture.isVip,
        },
      });
      created++;
    }
    return { created, matched };
  }

  private async importCategories(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = CategoryFixtureSchema.parse(raw);
      const existing = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.categories,
        fixture.sourceId,
      );
      if (existing) {
        matched++;
        continue;
      }
      const tenantId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceTenantId,
      );
      if (opts.dryRun) {
        created++;
        continue;
      }
      const row = await tx.category.create({
        data: {
          tenantId,
          name: fixture.name,
          kind: fixture.kind,
        },
      });
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.categories,
        fixture.sourceId,
        row.id,
        tenantId,
      );
      created++;
    }
    return { created, matched };
  }

  private async importManufacturers(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = ManufacturerFixtureSchema.parse(raw);
      const existing = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.manufacturers,
        fixture.sourceId,
      );
      if (existing) {
        matched++;
        continue;
      }
      const tenantId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceTenantId,
      );
      if (opts.dryRun) {
        created++;
        continue;
      }
      const row = await tx.manufacturer.create({
        data: {
          tenantId,
          name: fixture.name,
          url: fixture.url ?? null,
          supportEmail: fixture.supportEmail ?? null,
          supportPhone: fixture.supportPhone ?? null,
        },
      });
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.manufacturers,
        fixture.sourceId,
        row.id,
        tenantId,
      );
      created++;
    }
    return { created, matched };
  }

  private async importAssetModels(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = AssetModelFixtureSchema.parse(raw);
      const existing = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.assetModels,
        fixture.sourceId,
      );
      if (existing) {
        matched++;
        continue;
      }
      const tenantId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceTenantId,
      );
      const categoryId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.categories,
        fixture.sourceCategoryId,
      );
      let manufacturerId: string | null = null;
      if (fixture.sourceManufacturerId) {
        manufacturerId = await this.resolveBySource(
          tx,
          source,
          IDENTITY_MAP_ENTITY.manufacturers,
          fixture.sourceManufacturerId,
        );
      }
      if (opts.dryRun) {
        created++;
        continue;
      }
      const row = await tx.assetModel.create({
        data: {
          tenantId,
          categoryId,
          manufacturerId,
          name: fixture.name,
          modelNumber: fixture.modelNumber ?? null,
          imageUrl: fixture.imageUrl ?? null,
        },
      });
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.assetModels,
        fixture.sourceId,
        row.id,
        tenantId,
      );
      created++;
    }
    return { created, matched };
  }

  private async importAssets(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    rows: unknown[],
    opts: ImportOptions,
  ): Promise<{ created: number; matched: number }> {
    let created = 0;
    let matched = 0;
    for (const raw of rows) {
      const fixture = AssetFixtureSchema.parse(raw);
      const existing = await this.resolveBySource(
        tx,
        source,
        IDENTITY_MAP_ENTITY.assets,
        fixture.sourceId,
      );
      if (existing) {
        matched++;
        continue;
      }
      const tenantId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.tenants,
        fixture.sourceTenantId,
      );
      const modelId = await this.requireMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.assetModels,
        fixture.sourceModelId,
      );
      if (opts.dryRun) {
        created++;
        continue;
      }
      const row = await tx.asset.create({
        data: {
          tenantId,
          modelId,
          tag: fixture.tag,
          name: fixture.name,
          serial: fixture.serial ?? null,
          status: fixture.status,
          bookable: fixture.bookable,
          customFields: fixture.customFields as Prisma.InputJsonValue,
        },
      });
      await this.recordMapping(
        tx,
        source,
        IDENTITY_MAP_ENTITY.assets,
        fixture.sourceId,
        row.id,
        tenantId,
      );
      created++;
    }
    return { created, matched };
  }

  // ---------------------------------------------------------------------
  // Identity map primitives
  // ---------------------------------------------------------------------

  private async resolveBySource(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    entity: string,
    sourceId: string,
  ): Promise<string | null> {
    const row = await tx.importIdentityMap.findUnique({
      where: { source_entity_sourceId: { source, entity, sourceId } },
    });
    return row?.panoramaId ?? null;
  }

  private async requireMapping(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    entity: string,
    sourceId: string,
  ): Promise<string> {
    const resolved = await this.resolveBySource(tx, source, entity, sourceId);
    if (!resolved) {
      throw new Error(
        `import: ${entity} sourceId=${sourceId} not found in identity map. Parent fixture must be imported first.`,
      );
    }
    return resolved;
  }

  private async recordMapping(
    tx: Prisma.TransactionClient,
    source: FixtureSource,
    entity: string,
    sourceId: string,
    panoramaId: string,
    tenantId?: string,
  ): Promise<void> {
    await tx.importIdentityMap.create({
      data: {
        source,
        entity,
        sourceId,
        panoramaId,
        tenantId: tenantId ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------
  // File IO
  // ---------------------------------------------------------------------

  private async readManifest(dir: string): Promise<Manifest> {
    const path = join(dir, FIXTURE_FILES.manifest);
    const raw = await fs.readFile(path, 'utf8');
    return ManifestSchema.parse(JSON.parse(raw));
  }

  private async readFixture(dir: string, file: string): Promise<unknown[] | null> {
    const path = join(dir, file);
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`fixture ${file} must be a JSON array`);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
