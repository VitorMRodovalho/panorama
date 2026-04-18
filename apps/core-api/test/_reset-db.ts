import type { PrismaClient } from '@prisma/client';

/**
 * Shared test helper: wipe every domain table in the correct order,
 * bypassing the `enforce_at_least_one_owner` trigger (migration 0005)
 * which would otherwise refuse to delete the last Owner of each tenant.
 *
 * Uses the `panorama.bypass_owner_check` session GUC the trigger
 * function understands. Runs every statement inside one transaction
 * so the bypass is LOCAL to the reset and disappears with the
 * transaction — no risk of leaking "no enforcement" to subsequent
 * queries on the same connection.
 *
 * Order is reverse-FK-dependency so the deletes succeed without
 * relying on CASCADE. import_identity_map and audit_events get
 * swept too — tests that care about audit assertions rely on a
 * known-empty starting state.
 */
export async function resetTestDb(admin: PrismaClient): Promise<void> {
  await admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL panorama.bypass_owner_check = 'on'");
    await tx.blackoutSlot.deleteMany();
    await tx.invitation.deleteMany();
    await tx.reservation.deleteMany();
    await tx.asset.deleteMany();
    await tx.assetModel.deleteMany();
    await tx.manufacturer.deleteMany();
    await tx.category.deleteMany();
    await tx.personalAccessToken.deleteMany();
    await tx.tenantMembership.deleteMany();
    await tx.authIdentity.deleteMany();
    await tx.user.deleteMany();
    await tx.tenant.deleteMany();
    await tx.importIdentityMap.deleteMany();
    await tx.auditEvent.deleteMany();
  });
}
