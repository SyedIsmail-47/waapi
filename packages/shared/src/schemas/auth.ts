import { z } from "zod";
import { MEMBER_ROLES } from "../constants.js";

const turnstileToken = z.string().min(1).max(2048).optional();

export const registerBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(128),
  name: z.string().min(1).max(120).optional(),
  turnstileToken,
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

export const memberRoleSchema = z.enum(MEMBER_ROLES);

export const meResponseSchema = z.object({
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  email: z.string().email(),
  emailVerifiedAt: z.string().datetime().nullable(),
  role: memberRoleSchema,
  accountName: z.string(),
});
