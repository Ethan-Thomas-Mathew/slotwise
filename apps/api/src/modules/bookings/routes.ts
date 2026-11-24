import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  BookingDto,
  BookingListQuery,
  BookingListResponse,
  HoldRequest,
  RescheduleRequest,
} from '@slotwise/shared';
import type { AppDeps } from '../../app';
import { runEffects, type Effects } from '../../jobs/effects';
import { bookingsHeld } from '../../metrics';
import { idParam } from '../../http/params';
import { parse, respond } from '../../http/validation';
import { inTenant, requireRole, tenantContext } from '../../http/auth';
import type { BookingStatus } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-tx';
import * as repo from './repo';
import * as svc from './service';

export async function bookingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const actorOf = (req: FastifyRequest): svc.Actor => {
    const c = tenantContext(req);
    return { userId: c.userId, membershipId: c.membershipId, role: c.role };
  };

  /** Runs a change in the tenant's transaction, then (after commit) its side effects. */
  async function change<T>(
    req: FastifyRequest,
    fn: (tx: TenantTx, effects: Effects) => Promise<T>,
  ) {
    const effects: Effects = [];
    const result = await inTenant(db, req, (tx) => fn(tx, effects));
    await runEffects(effects, req.log);
    return result;
  }

  async function dto(req: FastifyRequest, id: string) {
    const actor = actorOf(req);
    return inTenant(db, req, async (tx) => {
      const row = await svc.getVisibleBooking(tx, actor, id);
      const [d] = await svc.toBookingDtos(tx, [row], actor);
      return respond(BookingDto, d!);
    });
  }

  app.post('/bookings/hold', { preHandler: requireRole('CUSTOMER') }, async (req, reply) => {
    const body = parse(HoldRequest, req.body);
    const booking = await change(req, (tx, effects) =>
      svc.holdSlot(tx, actorOf(req), body, effects, deps),
    );
    bookingsHeld.inc();
    reply.status(201);
    return dto(req, booking.id);
  });

  app.get('/bookings/mine', { preHandler: requireRole('CUSTOMER') }, async (req) => {
    const actor = actorOf(req);
    const bookings = await inTenant(db, req, async (tx) => {
      const rows = await repo.listBookings(tx, {
        customerMembershipId: actor.membershipId,
        statuses: ['HELD', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
        order: 'desc',
      });
      return svc.toBookingDtos(tx, rows, actor);
    });
    return respond(BookingListResponse, { bookings });
  });

  /** Owner: all bookings, filterable. */
  app.get('/bookings', { preHandler: requireRole('OWNER') }, async (req) => {
    const q = parse(BookingListQuery, req.query);
    const actor = actorOf(req);
    const bookings = await inTenant(db, req, async (tx) => {
      const rows = await repo.listBookings(tx, {
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        statuses: q.status
          ? [q.status]
          : (['HELD', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as BookingStatus[]),
        staffMembershipId: q.staffId,
      });
      return svc.toBookingDtos(tx, rows, actor);
    });
    return respond(BookingListResponse, { bookings });
  });

  /** Staff: their own schedule. Owners may look at anyone's with ?staffId=. */
  app.get('/staff/schedule', { preHandler: requireRole('STAFF', 'OWNER') }, async (req) => {
    const q = parse(BookingListQuery, req.query);
    const actor = actorOf(req);
    const staffId = actor.role === 'OWNER' ? (q.staffId ?? actor.membershipId) : actor.membershipId;
    const bookings = await inTenant(db, req, async (tx) => {
      const rows = await repo.listBookings(tx, {
        staffMembershipId: staffId,
        from: q.from ? new Date(q.from) : new Date(Date.now() - 86400_000),
        to: q.to ? new Date(q.to) : new Date(Date.now() + 14 * 86400_000),
        statuses: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'],
      });
      return svc.toBookingDtos(tx, rows, actor);
    });
    return respond(BookingListResponse, { bookings });
  });

  app.get(
    '/bookings/:id',
    { preHandler: requireRole('OWNER', 'STAFF', 'CUSTOMER') },
    async (req) => {
      return dto(req, idParam(req, 'id', 'Booking'));
    },
  );

  app.post(
    '/bookings/:id/cancel',
    { preHandler: requireRole('OWNER', 'STAFF', 'CUSTOMER') },
    async (req) => {
      const id = idParam(req, 'id', 'Booking');
      await change(req, (tx, effects) => svc.cancelBooking(tx, actorOf(req), id, effects, deps));
      return dto(req, id);
    },
  );

  app.post(
    '/bookings/:id/reschedule',
    { preHandler: requireRole('OWNER', 'STAFF', 'CUSTOMER') },
    async (req) => {
      const id = idParam(req, 'id', 'Booking');
      const body = parse(RescheduleRequest, req.body);
      await change(req, (tx, effects) =>
        svc.rescheduleBooking(tx, actorOf(req), id, body, effects, deps),
      );
      return dto(req, id);
    },
  );

  app.post(
    '/bookings/:id/complete',
    { preHandler: requireRole('OWNER', 'STAFF', 'CUSTOMER') },
    async (req) => {
      const id = idParam(req, 'id', 'Booking');
      await inTenant(db, req, (tx) => svc.markOutcome(tx, actorOf(req), id, 'COMPLETED'));
      return dto(req, id);
    },
  );

  app.post(
    '/bookings/:id/no-show',
    { preHandler: requireRole('OWNER', 'STAFF', 'CUSTOMER') },
    async (req) => {
      const id = idParam(req, 'id', 'Booking');
      await inTenant(db, req, (tx) => svc.markOutcome(tx, actorOf(req), id, 'NO_SHOW'));
      return dto(req, id);
    },
  );
}
