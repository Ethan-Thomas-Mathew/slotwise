import type { FastifyInstance } from 'fastify';
import { DataExport, DeleteAccountRequest, OkResponse } from '@slotwise/shared';
import type { AppDeps } from '../../app';
import { parse, respond } from '../../http/validation';
import { requireUser } from '../../http/auth';
import { clearSessionCookie } from '../auth/sessions';
import { deleteMyAccount, exportMyData } from './service';

export async function privacyRoutes(app: FastifyInstance, { db }: AppDeps) {
  const limit = (max: number) =>
    app.rateLimit({
      max,
      timeWindow: '15 minutes',
      keyGenerator: (req) => `${req.routeOptions.url}:${req.auth?.user.id ?? req.ip}`,
    });

  app.get('/account/data', { preHandler: [requireUser, limit(10)] }, async (req, reply) => {
    const myData = await exportMyData(db, req.auth!.user.id);
    const day = myData.exportedAt.slice(0, 10);
    reply.header('content-disposition', `attachment; filename="slotwise-my-data-${day}.json"`);
    reply.header('cache-control', 'no-store');
    return respond(DataExport, myData);
  });

  app.post('/account/delete', { preHandler: [requireUser, limit(5)] }, async (req, reply) => {
    const body = parse(DeleteAccountRequest, req.body);
    await deleteMyAccount(db, req.auth!.user.id, body);
    req.log.info({ userId: req.auth!.user.id }, 'Account erased at the user’s request');
    clearSessionCookie(reply);
    return respond(OkResponse, { ok: true });
  });
}
