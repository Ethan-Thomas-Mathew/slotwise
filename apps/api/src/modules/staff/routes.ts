import type { FastifyInstance } from 'fastify';
import {
  AvailabilityRule,
  clockToMinutes,
  minutesToClock,
  OkResponse,
  SetAvailabilityRequest,
  SetStaffServicesRequest,
  StaffDto,
  TimeOffDto,
  TimeOffInput,
} from '@slotwise/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import type { TenantTx } from '../../db/tenant-tx';
import { AppError, notFound } from '../../lib/errors';
import { idParam } from '../../lib/params';
import { iso, parse, respond } from '../../lib/validate';
import { inTenant, requireRole, tenantContext } from '../../plugins/auth';
import { writeAudit } from '../audit/repo';
import * as availability from '../availability/repo';
import * as repo from './repo';

const StaffListResponse = z.object({ staff: z.array(StaffDto) });
const AvailabilityResponse = z.object({ rules: z.array(AvailabilityRule) });
const TimeOffListResponse = z.object({ timeOff: z.array(TimeOffDto) });

async function mustBeStaff(tx: TenantTx, membershipId: string) {
  const s = await repo.getStaffMember(tx, membershipId);
  if (!s) throw notFound('Staff member');
  return s;
}

export async function staffRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/staff', { preHandler: requireRole('OWNER') }, async (req) => {
    const rows = await inTenant(db, req, (tx) => repo.listStaff(tx));
    return respond(StaffListResponse, {
      staff: rows.map((s) => ({
        membershipId: s.id,
        name: s.name,
        email: s.email,
        role: s.role,
        serviceIds: s.service_ids ?? [],
      })),
    });
  });

  app.put('/staff/:id/services', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Staff member');
    const body = parse(SetStaffServicesRequest, req.body);
    await inTenant(db, req, async (tx) => {
      await mustBeStaff(tx, id);
      try {
        await repo.setStaffServices(tx, id, [...new Set(body.serviceIds)]);
      } catch {
        // Composite foreign key rejected an unknown (or other-tenant) service id.
        throw notFound('Service');
      }
      await writeAudit(tx, {
        action: 'staff.services.update',
        entity: 'membership',
        entityId: id,
        after: body,
      });
    });
    return respond(OkResponse, { ok: true });
  });

  /** Removes someone from the team. They keep their account (and booking history) as a customer. */
  app.delete('/staff/:id', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Staff member');
    await inTenant(db, req, async (tx) => {
      const s = await mustBeStaff(tx, id);
      if (s.role === 'OWNER') throw new AppError('CONFLICT', 'The owner cannot be removed');
      if (await repo.staffHasUpcomingBookings(tx, id)) {
        throw new AppError(
          'CONFLICT',
          'This person has upcoming bookings. Cancel or move them first.',
        );
      }
      await repo.downgradeStaffToCustomer(tx, id);
      await writeAudit(tx, {
        action: 'staff.remove',
        entity: 'membership',
        entityId: id,
        before: { name: s.name, email: s.email },
      });
    });
    return respond(OkResponse, { ok: true });
  });

  // ---------- Working hours ----------

  /** Owners can read anyone's hours; staff can read their own. */
  app.get('/staff/:id/availability', { preHandler: requireRole('OWNER', 'STAFF') }, async (req) => {
    const id = idParam(req, 'id', 'Staff member');
    const ctx = tenantContext(req);
    if (ctx.role === 'STAFF' && ctx.membershipId !== id) throw notFound('Staff member');
    const rules = await inTenant(db, req, async (tx) => {
      await mustBeStaff(tx, id);
      return availability.listRules(tx, id);
    });
    return respond(AvailabilityResponse, {
      rules: rules.map((r) => ({
        weekday: r.weekday,
        start: minutesToClock(r.start_minute),
        end: minutesToClock(r.end_minute),
      })),
    });
  });

  app.put('/staff/:id/availability', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Staff member');
    const body = parse(SetAvailabilityRequest, req.body);
    await inTenant(db, req, async (tx) => {
      await mustBeStaff(tx, id);
      const before = await availability.listRules(tx, id);
      await availability.replaceRules(
        tx,
        id,
        body.rules.map((r) => ({
          weekday: r.weekday,
          startMinute: clockToMinutes(r.start),
          endMinute: clockToMinutes(r.end),
        })),
      );
      await writeAudit(tx, {
        action: 'availability.update',
        entity: 'membership',
        entityId: id,
        before: before.map((r) => ({
          weekday: r.weekday,
          start: minutesToClock(r.start_minute),
          end: minutesToClock(r.end_minute),
        })),
        after: body.rules,
      });
    });
    return respond(OkResponse, { ok: true });
  });

  // ---------- Time off ----------

  app.get('/staff/:id/time-off', { preHandler: requireRole('OWNER', 'STAFF') }, async (req) => {
    const id = idParam(req, 'id', 'Staff member');
    const ctx = tenantContext(req);
    if (ctx.role === 'STAFF' && ctx.membershipId !== id) throw notFound('Staff member');
    const rows = await inTenant(db, req, async (tx) => {
      await mustBeStaff(tx, id);
      return availability.listTimeOff(tx, id, {
        from: new Date(Date.now() - 30 * 86400_000),
        to: new Date('9999-01-01'),
      });
    });
    return respond(TimeOffListResponse, {
      timeOff: rows.map((r) => ({
        id: r.id,
        startAt: iso(r.start_at),
        endAt: iso(r.end_at),
        reason: r.reason,
      })),
    });
  });

  app.post('/staff/:id/time-off', { preHandler: requireRole('OWNER') }, async (req, reply) => {
    const id = idParam(req, 'id', 'Staff member');
    const body = parse(TimeOffInput, req.body);
    const row = await inTenant(db, req, async (tx) => {
      await mustBeStaff(tx, id);
      const r = await availability.insertTimeOff(tx, id, {
        startAt: new Date(body.startAt),
        endAt: new Date(body.endAt),
        reason: body.reason,
      });
      await writeAudit(tx, {
        action: 'time_off.create',
        entity: 'time_off',
        entityId: r.id,
        after: body,
      });
      return r;
    });
    reply.status(201);
    return respond(TimeOffDto, {
      id: row.id,
      startAt: iso(row.start_at),
      endAt: iso(row.end_at),
      reason: row.reason,
    });
  });

  app.delete('/time-off/:id', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Time off');
    await inTenant(db, req, async (tx) => {
      const removed = await availability.deleteTimeOff(tx, id);
      if (!removed) throw notFound('Time off');
      await writeAudit(tx, {
        action: 'time_off.delete',
        entity: 'time_off',
        entityId: id,
        before: {
          startAt: iso(removed.start_at),
          endAt: iso(removed.end_at),
          reason: removed.reason,
        },
      });
    });
    return respond(OkResponse, { ok: true });
  });
}
