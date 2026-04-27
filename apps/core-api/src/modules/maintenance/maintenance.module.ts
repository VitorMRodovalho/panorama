/**
 * Maintenance module — MVP slice of ADR-0016 + auto-suggest subscriber
 * (#74 PILOT-03 + #40 ARCH-15).
 *
 * Forbid-list invariant (ADR-0016 §1.4 + §7.2): the entire maintenance
 * module writes via `runInTenant(tenantId, …)` only — `runAsSuperAdmin`
 * is not used here, and the #58 allowlist gate enforces it across CI.
 *
 * Loaded conditionally at app boot when `FEATURE_MAINTENANCE` is on
 * (default false — see app.module.ts). Mirrors the FEATURE_INSPECTIONS
 * gating pattern so a community deploy with maintenance off doesn't
 * register the routes — and, by extension, doesn't register the
 * MaintenanceTicketSubscriber on the notification bus, so damage
 * check-in / FAIL inspection events flow through with no handler.
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { ChannelRegistry } from '../notification/channel-registry.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { MaintenanceTicketSubscriber } from './maintenance-ticket.subscriber.js';
import { MaintenanceSweepService } from './maintenance-sweep.service.js';

// PrismaModule + AuditModule are @Global so no explicit import needed.
@Module({
  imports: [NotificationModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService, MaintenanceTicketSubscriber, MaintenanceSweepService],
  exports: [MaintenanceService, MaintenanceSweepService],
})
export class MaintenanceModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly subscriber: MaintenanceTicketSubscriber,
  ) {}

  onModuleInit(): void {
    // ADR-0016 §5: register the auto-suggest subscriber on the bus. The
    // ChannelRegistry rejects duplicates by name, so a second module
    // load (HMR / test harness re-import) would fail loud. NotificationModule
    // is loaded eagerly in app.module.ts and registers its own handlers
    // before MaintenanceModule's onModuleInit runs.
    this.registry.register(this.subscriber);
    // MaintenanceSweepService starts its own BullMQ schedule via
    // OnModuleInit (gated by NODE_ENV != 'test' AND FEATURE_MAINTENANCE
    // == 'true'). No explicit start call needed here — Nest's lifecycle
    // resolves provider OnModuleInit hooks alongside the module's own.
  }
}
