import { Module } from '@nestjs/common';
import { ReservationConfigService } from './reservation.config.js';
import {
  BlackoutController,
  ReservationController,
} from './reservation.controller.js';
import { BlackoutService } from './blackout.service.js';
import { ReservationService } from './reservation.service.js';

/**
 * Reservation + Blackout module (ADR-0009, step 4 Part A).
 *
 * Ships create / list / cancel / approve / reject on reservations plus
 * admin-only CRUD on blackouts. Check-out + check-in + basket multi-
 * asset flows land in Part B.
 */
@Module({
  controllers: [ReservationController, BlackoutController],
  providers: [ReservationService, BlackoutService, ReservationConfigService],
  exports: [ReservationService, BlackoutService, ReservationConfigService],
})
export class ReservationModule {}
