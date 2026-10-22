import { z } from "zod";
import { MEMBER_ROLES } from "../constants.js";

const turnstileToken = z.string().min(1).max(2048).optional();

export const registerBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(128),
  name: z.string().min(1).max(120).optional(),
  /** Required when SIGNUPS_MODE=invite. */
  inviteCode: z.string().min(8).max(128).optional(),
  turnstileToken,
});

export const signupConfigResponseSchema = z.object({
  mode: z.enum(["open", "invite", "closed"]),
});

export const createInviteBodySchema = z.object({
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
  note: z.string().max(200).optional(),
});

export const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
  turnstileToken,
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(20).max(512).optional(),
});

export const verifyEmailBodySchema = z.object({
  token: z.string().min(20).max(512),
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().email().max(320),
  turnstileToken,
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(20).max(512),
  password: z.string().min(10).max(128),
});

export const createPatBodySchema = z.object({
  name: z.string().min(1).max(80),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
});

export const deleteAccountBodySchema = z.object({
  password: z.string().min(1).max(128),
});

export const memberRoleSchema = z.enum(MEMBER_ROLES);

export const meResponseSchema = z.object({
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  email: z.string().email(),
  emailVerifiedAt: z.string().datetime().nullable(),
  role: memberRoleSchema,
  accountName: z.string(),
});
