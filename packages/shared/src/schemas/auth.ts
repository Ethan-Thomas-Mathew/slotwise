import { z } from 'zod';
import { Email, Password, PersonName, Role, Slug, Uuid } from './common';

export const SignupOwnerRequest = z.object({
  businessName: z.string().trim().min(1).max(120),
  slug: Slug,
  timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
  name: PersonName,
  email: Email,
  password: Password,
});
export type SignupOwnerRequest = z.input<typeof SignupOwnerRequest>;

export const RegisterRequest = z.object({
  name: PersonName,
  email: Email,
  password: Password,
  /** Registering from a business's booking page joins that business as a customer. */
  tenantSlug: Slug.optional(),
});
export type RegisterRequest = z.input<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(128),
  tenantSlug: Slug.optional(),
});
export type LoginRequest = z.input<typeof LoginRequest>;

export const ForgotPasswordRequest = z.object({ email: Email });
export const ResetPasswordRequest = z.object({
  token: z.string().min(10).max(200),
  password: Password,
});

export const InvitePreviewResponse = z.object({
  tenantName: z.string(),
  email: z.string(),
  userExists: z.boolean(),
});
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponse>;

export const AcceptInviteRequest = z.object({
  token: z.string().min(10).max(200),
  /** Needed only when the invited email has no account yet. */
  name: PersonName.optional(),
  password: z.string().min(1).max(128),
});

export const SwitchTenantRequest = z.object({
  slug: Slug,
  /** Join as a customer if not already a member (used by public booking pages). */
  joinAsCustomer: z.boolean().default(false),
});

export const MembershipSummary = z.object({
  membershipId: Uuid,
  tenantId: Uuid,
  tenantName: z.string(),
  tenantSlug: z.string(),
  role: Role,
});

export const MeResponse = z.object({
  user: z.object({ id: Uuid, name: z.string(), email: z.string() }),
  csrfToken: z.string(),
  activeTenant: z
    .object({
      id: Uuid,
      name: z.string(),
      slug: z.string(),
      timezone: z.string(),
      currency: z.string(),
      cancellationWindowHours: z.number().int(),
      bookingHorizonDays: z.number().int(),
      role: Role,
      membershipId: Uuid,
    })
    .nullable(),
  memberships: z.array(MembershipSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;
