import { z } from 'zod';

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name is too long').optional(),
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username is too long')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .toLowerCase()
    .optional(),
  bio: z.string().max(500, 'Bio is too long').optional(),
  location: z.string().max(100).optional(),
  occupation: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
});

export const updateDeveloperProfileSchema = z.object({
  github: z.url('Must be a valid URL').optional().or(z.literal('')),
  linkedin: z.url('Must be a valid URL').optional().or(z.literal('')),
  portfolio: z.url('Must be a valid URL').optional().or(z.literal('')),
  stackoverflow: z.url('Must be a valid URL').optional().or(z.literal('')),
  leetcode: z.url('Must be a valid URL').optional().or(z.literal('')),
  codeforces: z.url('Must be a valid URL').optional().or(z.literal('')),
  hackerrank: z.url('Must be a valid URL').optional().or(z.literal('')),
  x: z.url('Must be a valid URL').optional().or(z.literal('')),
});

export const updateSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  language: z.string().length(2).optional(),
  timezone: z.string().optional(),
});

export const updatePrivacySchema = z.object({
  isPrivate: z.boolean().optional(),
  hideEmail: z.boolean().optional(),
  hideActivity: z.boolean().optional(),
});

export const updateSkillsSchema = z.object({
  skills: z.array(z.string().min(1).max(50)).max(20, 'Maximum 20 skills allowed'),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateDeveloperProfileInput = z.infer<typeof updateDeveloperProfileSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>;
export type UpdateSkillsInput = z.infer<typeof updateSkillsSchema>;
