import {
  AcceptInviteRequest,
  AuditLogDto,
  AuditLogQuery,
  BookingDto,
  BookingListQuery,
  BookingListResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  DashboardSummary,
  DataExport,
  DeleteAccountRequest,
  ErrorResponse,
  ForgotPasswordRequest,
  HoldRequest,
  InvitePreviewResponse,
  InviteStaffRequest,
  InviteStaffResponse,
  LoginRequest,
  MeResponse,
  NotificationDto,
  OkResponse,
  OpenDaysQuery,
  OpenDaysResponse,
  PublicTenantResponse,
  RegisterRequest,
  RescheduleRequest,
  ResetPasswordRequest,
  ServiceDto,
  ServiceInput,
  ServicePatch,
  SetAvailabilityRequest,
  SetStaffServicesRequest,
  SignupOwnerRequest,
  SlotsQuery,
  SlotsResponse,
  SwitchTenantRequest,
  TenantSettingsPatch,
  TimeOffDto,
  TimeOffInput,
  HOLD_MINUTES,
} from '@slotwise/shared';
import { z } from 'zod';
import { NotificationListQuery } from '../modules/notifications/routes';
import {
  AvailabilityResponse,
  StaffListResponse,
  TimeOffListResponse,
} from '../modules/staff/routes';
import { TenantSettings } from '../modules/tenants/routes';

/**
 * The API documentation (OpenAPI 3.1), generated from the SAME Zod schemas the
 * routes use to validate requests and responses. So the docs cannot quietly
 * drift from the code: a test checks that every route is listed here and that
 * the committed docs/openapi.json is up to date.
 */

type Who = 'public' | 'signed-in' | ('OWNER' | 'STAFF' | 'CUSTOMER')[];

export interface Operation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Fastify-style path, e.g. /bookings/:id */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  who: Who;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  /** Rate limited: 5 attempts per 15 minutes per IP + email. */
  strictLimit?: boolean;
}

const list = <T extends z.ZodType>(key: string, item: T) => z.object({ [key]: z.array(item) });
const owner: Who = ['OWNER'];
const anyMember: Who = ['OWNER', 'STAFF', 'CUSTOMER'];

export const operations: Operation[] = [
  // --- Ops -------------------------------------------------------------------
  {
    method: 'get',
    path: '/health',
    tag: 'Ops',
    summary: 'Liveness: the process is running',
    who: 'public',
    response: z.object({ status: z.literal('ok') }),
  },
  {
    method: 'get',
    path: '/ready',
    tag: 'Ops',
    summary: 'Readiness: database and Redis are reachable (503 if not)',
    who: 'public',
    response: z.object({
      status: z.enum(['ok', 'fail']),
      checks: z.record(z.string(), z.enum(['ok', 'fail'])),
    }),
  },

  // --- Auth ------------------------------------------------------------------
  {
    method: 'post',
    path: '/auth/signup',
    tag: 'Auth',
    summary: 'Create a business and its owner account, and log in',
    who: 'public',
    body: SignupOwnerRequest,
    response: MeResponse,
    status: 201,
    strictLimit: true,
  },
  {
    method: 'post',
    path: '/auth/register',
    tag: 'Auth',
    summary: 'Create a customer account (optionally joining a business), and log in',
    who: 'public',
    body: RegisterRequest,
    response: MeResponse,
    status: 201,
    strictLimit: true,
  },
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary: 'Log in; sets the session cookie',
    who: 'public',
    body: LoginRequest,
    response: MeResponse,
    strictLimit: true,
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'Auth',
    summary: 'Log out (deletes the session)',
    who: 'signed-in',
    response: OkResponse,
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'The current user, their memberships and the active business',
    who: 'signed-in',
    response: MeResponse,
  },
  {
    method: 'post',
    path: '/auth/active-tenant',
    tag: 'Auth',
    summary: 'Switch which business this session acts in',
    who: 'signed-in',
    body: SwitchTenantRequest,
    response: MeResponse,
  },
  {
    method: 'post',
    path: '/auth/forgot-password',
    tag: 'Auth',
    summary: 'Email a password reset link',
    description: 'Always answers ok, so it cannot be used to discover which emails have accounts.',
    who: 'public',
    body: ForgotPasswordRequest,
    response: OkResponse,
    strictLimit: true,
  },
  {
    method: 'post',
    path: '/auth/reset-password',
    tag: 'Auth',
    summary: 'Set a new password with a reset token (logs out every session)',
    who: 'public',
    body: ResetPasswordRequest,
    response: OkResponse,
    strictLimit: true,
  },
  {
    method: 'get',
    path: '/auth/invites/:token',
    tag: 'Auth',
    summary: 'Preview a staff invite before accepting it',
    who: 'public',
    response: InvitePreviewResponse,
  },
  {
    method: 'post',
    path: '/auth/accept-invite',
    tag: 'Auth',
    summary: 'Accept a staff invite and log in',
    who: 'public',
    body: AcceptInviteRequest,
    response: MeResponse,
    strictLimit: true,
  },

  // --- Your data (privacy) -------------------------------------------------
  {
    method: 'get',
    path: '/account/data',
    tag: 'Account',
    summary: 'Download everything Slotwise stores about me (JSON file)',
    who: 'signed-in',
    response: DataExport,
  },
  {
    method: 'post',
    path: '/account/delete',
    tag: 'Account',
    summary: 'Erase my account (customers only; password + "DELETE" required)',
    description:
      'Refused for owners, team members and anyone with upcoming bookings. Past bookings stay in the business records but no longer name the person.',
    who: 'signed-in',
    body: DeleteAccountRequest,
    response: OkResponse,
  },

  // --- Public booking page ---------------------------------------------------
  {
    method: 'get',
    path: '/public/:slug',
    tag: 'Public',
    summary: "A business's public page: name, services and staff",
    who: 'public',
    response: PublicTenantResponse,
  },
  {
    method: 'get',
    path: '/public/:slug/slots',
    tag: 'Public',
    summary: 'Free start times on one day (staffId may be "any")',
    who: 'public',
    query: SlotsQuery,
    response: SlotsResponse,
  },
  {
    method: 'get',
    path: '/public/:slug/days',
    tag: 'Public',
    summary: 'Which of the next days have at least one free slot',
    who: 'public',
    query: OpenDaysQuery,
    response: OpenDaysResponse,
  },

  // --- Bookings --------------------------------------------------------------
  {
    method: 'post',
    path: '/bookings/hold',
    tag: 'Bookings',
    summary: `Hold a slot for ${HOLD_MINUTES} minutes while the customer pays`,
    description:
      'Two customers can never hold the same time: the database rejects the second one with 409 SLOT_TAKEN.',
    who: ['CUSTOMER'],
    body: HoldRequest,
    response: BookingDto,
    status: 201,
  },
  {
    method: 'get',
    path: '/bookings/mine',
    tag: 'Bookings',
    summary: "The signed-in customer's bookings",
    who: ['CUSTOMER'],
    response: BookingListResponse,
  },
  {
    method: 'get',
    path: '/bookings',
    tag: 'Bookings',
    summary: 'All bookings of the business, filtered',
    who: owner,
    query: BookingListQuery,
    response: BookingListResponse,
  },
  {
    method: 'get',
    path: '/staff/schedule',
    tag: 'Bookings',
    summary: "The signed-in staff member's own schedule",
    who: ['STAFF', 'OWNER'],
    query: BookingListQuery,
    response: BookingListResponse,
  },
  {
    method: 'get',
    path: '/bookings/:id',
    tag: 'Bookings',
    summary: 'One booking (customers see only their own, staff only theirs)',
    who: anyMember,
    response: BookingDto,
  },
  {
    method: 'post',
    path: '/bookings/:id/cancel',
    tag: 'Bookings',
    summary: 'Cancel; refunds automatically when the cancellation policy allows',
    who: anyMember,
    response: BookingDto,
  },
  {
    method: 'post',
    path: '/bookings/:id/reschedule',
    tag: 'Bookings',
    summary: 'Move a confirmed booking to another free time',
    who: anyMember,
    body: RescheduleRequest,
    response: BookingDto,
  },
  {
    method: 'post',
    path: '/bookings/:id/complete',
    tag: 'Bookings',
    summary: 'Mark a past booking as completed (owner or assigned staff)',
    who: anyMember,
    response: BookingDto,
  },
  {
    method: 'post',
    path: '/bookings/:id/no-show',
    tag: 'Bookings',
    summary: 'Mark a past booking as a no-show (owner or assigned staff)',
    who: anyMember,
    response: BookingDto,
  },

  // --- Payments --------------------------------------------------------------
  {
    method: 'post',
    path: '/payments/order',
    tag: 'Payments',
    summary: 'Create (or reuse) the payment order for a held booking',
    who: ['CUSTOMER'],
    body: CreateOrderRequest,
    response: CreateOrderResponse,
  },
  {
    method: 'post',
    path: '/webhooks/razorpay',
    tag: 'Payments',
    summary: 'Payment provider webhook (signed)',
    description:
      'Called by Razorpay, not by browsers. The HMAC signature in x-razorpay-signature is checked over the raw body; each event id is processed once.',
    who: 'public',
    body: z.object({ event: z.string(), payload: z.record(z.string(), z.unknown()) }),
    response: z.object({ status: z.enum(['processed', 'duplicate', 'ignored', 'rejected']) }),
  },
  {
    method: 'post',
    path: '/dev/mock-payments/:orderId/:outcome',
    tag: 'Payments',
    summary: 'Development only: simulate the customer paying (outcome = capture | fail)',
    description:
      'Exists only with the mock payment provider. It signs a fake webhook and sends it through the real webhook route.',
    who: ['CUSTOMER'],
    response: z.object({ status: z.enum(['processed', 'duplicate', 'ignored', 'rejected']) }),
  },

  // --- Catalog and team ------------------------------------------------------
  {
    method: 'get',
    path: '/services',
    tag: 'Services',
    summary: 'List services',
    who: ['OWNER', 'STAFF'],
    response: list('services', ServiceDto),
  },
  {
    method: 'post',
    path: '/services',
    tag: 'Services',
    summary: 'Create a service',
    who: owner,
    body: ServiceInput,
    response: ServiceDto,
    status: 201,
  },
  {
    method: 'patch',
    path: '/services/:id',
    tag: 'Services',
    summary: 'Update a service',
    who: owner,
    body: ServicePatch,
    response: ServiceDto,
  },
  {
    method: 'delete',
    path: '/services/:id',
    tag: 'Services',
    summary: 'Archive a service (kept for past bookings)',
    who: owner,
    response: OkResponse,
  },
  {
    method: 'get',
    path: '/staff',
    tag: 'Team',
    summary: 'List staff',
    who: owner,
    response: StaffListResponse,
  },
  {
    method: 'post',
    path: '/staff/invites',
    tag: 'Team',
    summary: 'Invite a staff member (returns the invite link; also emailed)',
    who: owner,
    body: InviteStaffRequest,
    response: InviteStaffResponse,
    status: 201,
  },
  {
    method: 'delete',
    path: '/staff/:id',
    tag: 'Team',
    summary: 'Remove a staff member from the business',
    who: owner,
    response: OkResponse,
  },
  {
    method: 'put',
    path: '/staff/:id/services',
    tag: 'Team',
    summary: 'Set which services a staff member performs',
    who: owner,
    body: SetStaffServicesRequest,
    response: OkResponse,
  },
  {
    method: 'get',
    path: '/staff/:id/availability',
    tag: 'Team',
    summary: 'Weekly working hours',
    who: ['OWNER', 'STAFF'],
    response: AvailabilityResponse,
  },
  {
    method: 'put',
    path: '/staff/:id/availability',
    tag: 'Team',
    summary: 'Replace weekly working hours',
    who: owner,
    body: SetAvailabilityRequest,
    response: OkResponse,
  },
  {
    method: 'get',
    path: '/staff/:id/time-off',
    tag: 'Team',
    summary: 'Upcoming time off',
    who: ['OWNER', 'STAFF'],
    response: TimeOffListResponse,
  },
  {
    method: 'post',
    path: '/staff/:id/time-off',
    tag: 'Team',
    summary: 'Add time off',
    who: owner,
    body: TimeOffInput,
    response: TimeOffDto,
    status: 201,
  },
  {
    method: 'delete',
    path: '/time-off/:id',
    tag: 'Team',
    summary: 'Delete time off',
    who: owner,
    response: OkResponse,
  },

  // --- Business admin --------------------------------------------------------
  {
    method: 'get',
    path: '/tenant/settings',
    tag: 'Business',
    summary: 'Business settings',
    who: owner,
    response: TenantSettings,
  },
  {
    method: 'patch',
    path: '/tenant/settings',
    tag: 'Business',
    summary: 'Update business settings',
    who: owner,
    body: TenantSettingsPatch,
    response: TenantSettings,
  },
  {
    method: 'get',
    path: '/dashboard/summary',
    tag: 'Business',
    summary: "Today's numbers for the owner dashboard",
    who: owner,
    response: DashboardSummary,
  },
  {
    method: 'get',
    path: '/audit-logs',
    tag: 'Business',
    summary: 'Who changed what, and when',
    who: owner,
    query: AuditLogQuery,
    response: list('logs', AuditLogDto),
  },
  {
    method: 'get',
    path: '/notifications',
    tag: 'Business',
    summary: 'Emails the system sent or failed to send',
    who: owner,
    query: NotificationListQuery,
    response: list('notifications', NotificationDto),
  },
  {
    method: 'post',
    path: '/notifications/:id/retry',
    tag: 'Business',
    summary: 'Retry a failed email',
    who: owner,
    response: OkResponse,
  },
];

// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
}

const toOpenApiPath = (p: string) => p.replace(/:(\w+)/g, '{$1}');

function queryParameters(schema: z.ZodType) {
  const js = jsonSchema(schema, 'input') as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: js.required?.includes(name) ?? false,
    schema: s,
  }));
}

function describeWho(who: Who): string {
  if (who === 'public') return 'No login needed.';
  if (who === 'signed-in') return 'Any signed-in user.';
  return `Roles: ${who.join(', ')}.`;
}

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const pathParams = [...op.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: m[1] === 'id' ? { type: 'string', format: 'uuid' } : { type: 'string' },
    }));
    const isWrite = op.method !== 'get';
    const authed = op.who !== 'public';
    const responses: Record<string, unknown> = {
      [String(op.status ?? 200)]: {
        description: 'Success',
        ...(op.response
          ? { content: { 'application/json': { schema: jsonSchema(op.response, 'output') } } }
          : {}),
      },
    };
    if (op.body || op.query || pathParams.length) responses['400'] = err('Invalid request');
    if (authed) {
      responses['401'] = err('Not logged in');
      responses['403'] = err('Logged in, but not allowed (role or CSRF check)');
    }
    if (pathParams.length) responses['404'] = err('Not found (or belongs to another business)');
    if (isWrite) responses['409'] = err('Conflict, e.g. SLOT_TAKEN or an invalid state change');
    if (op.strictLimit) responses['429'] = err('Too many attempts (5 per 15 minutes)');

    paths[toOpenApiPath(op.path)] ??= {};
    paths[toOpenApiPath(op.path)]![op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: [op.description, describeWho(op.who)].filter(Boolean).join('\n\n'),
      operationId: `${op.method}${op.path.replace(/[/:-](\w)/g, (_m, c: string) => c.toUpperCase())}`,
      ...(authed
        ? { security: [isWrite ? { session: [], csrf: [] } : { session: [] }] }
        : { security: [] }),
      parameters: [...pathParams, ...(op.query ? queryParameters(op.query) : [])],
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(op.body, 'input') } },
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Slotwise API',
      version: '1.0.0',
      description:
        'Multi-tenant booking API. Browsers authenticate with an httpOnly session cookie; ' +
        'every write also needs the x-csrf-token header from /auth/me. All errors share one shape.',
    },
    servers: [{ url: '/api', description: 'Through the web app (Vite or nginx proxy)' }],
    tags: [
      'Ops',
      'Auth',
      'Account',
      'Public',
      'Bookings',
      'Payments',
      'Services',
      'Team',
      'Business',
    ].map((name) => ({ name })),
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'sid' },
        csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
      },
      schemas: { ErrorResponse: jsonSchema(ErrorResponse, 'output') },
    },
    paths,
  };
}
