import type { FastifyInstance } from 'fastify';
import { OkResponse, ServiceDto, ServiceInput, ServicePatch } from '@slotwise/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import type { Service } from '../../db/schema';
import { AppError, notFound } from '../../http/errors';
import { idParam } from '../../http/params';
import { parse, respond } from '../../http/validation';
import { inTenant, requireRole } from '../../http/auth';
import { writeAudit } from '../audit/repo';
import * as repo from './repo';

export function toServiceDto(s: Service): ServiceDto {
  return {
    id: s.id,
    name: s.name,
    durationMinutes: s.duration_minutes,
    pricePaise: s.price_paise,
    active: s.active,
  };
}

export async function serviceRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/services', { preHandler: requireRole('OWNER', 'STAFF') }, async (req) => {
    const rows = await inTenant(db, req, (tx) => repo.listServices(tx));
    return respond(z.object({ services: z.array(ServiceDto) }), {
      services: rows.map(toServiceDto),
    });
  });

  app.post('/services', { preHandler: requireRole('OWNER') }, async (req, reply) => {
    const body = parse(ServiceInput, req.body);
    const created = await inTenant(db, req, async (tx) => {
      const s = await repo.insertService(tx, body);
      await writeAudit(tx, {
        action: 'service.create',
        entity: 'service',
        entityId: s.id,
        after: toServiceDto(s),
      });
      return s;
    });
    reply.status(201);
    return respond(ServiceDto, toServiceDto(created));
  });

  app.patch('/services/:id', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Service');
    const body = parse(ServicePatch, req.body);
    const updated = await inTenant(db, req, async (tx) => {
      const before = await repo.getService(tx, id);
      if (!before) throw notFound('Service');
      const after = await repo.updateService(tx, id, {
        name: body.name,
        duration_minutes: body.durationMinutes,
        price_paise: body.pricePaise,
        active: body.active,
      });
      await writeAudit(tx, {
        action: 'service.update',
        entity: 'service',
        entityId: id,
        before: toServiceDto(before),
        after: toServiceDto(after!),
      });
      return after!;
    });
    return respond(ServiceDto, toServiceDto(updated));
  });

  app.delete('/services/:id', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Service');
    await inTenant(db, req, async (tx) => {
      const before = await repo.getService(tx, id);
      if (!before) throw notFound('Service');
      if (await repo.serviceHasBookings(tx, id)) {
        throw new AppError(
          'CONFLICT',
          'This service has bookings. Deactivate it instead of deleting it.',
        );
      }
      await repo.deleteService(tx, id);
      await writeAudit(tx, {
        action: 'service.delete',
        entity: 'service',
        entityId: id,
        before: toServiceDto(before),
      });
    });
    return respond(OkResponse, { ok: true });
  });
}
