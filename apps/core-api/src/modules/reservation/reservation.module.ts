import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { ReservationConfigService } from './reservation.config.js';
import {
  BlackoutController,
  ReservationController,
} from './reservation.controller.js';
import { BlackoutService } from './blackout.service.js';
import { ReservationService } from './reservation.service.js';
import { ReservationSweepService } from './reservation-sweep.service.js';

/**
 * Reservation + Blackout module (ADR-0009, step 4 Part A + #77 PILOT-04).
 *
 * Ships create / list / cancel / approve / reject on reservations plus
 * admin-only CRUD on blackouts. Check-out + check-in + basket multi-
 * asset flows landed in Part B. The hourly overdue + no-show sweeps
 * (#77) live in `ReservationSweepService` — same module so the
 * service has direct access to ReservationConfigService for
 * `pickupWindowHours`.
 */
@Module({
  imports: [NotificationModule],
  controllers: [ReservationController, BlackoutController],
  providers: [
    ReservationService,
    BlackoutService,
    ReservationConfigService,
    ReservationSweepService,
  ],
  exports: [
    ReservationService,
    BlackoutService,
    ReservationConfigService,
    ReservationSweepService,
  ],
})
export class ReservationModule {}
