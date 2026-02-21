/**
 * Input Validation & Sanitization
 *
 * Shared validators for socket events and REST endpoints.
 * Strips HTML, enforces length limits, normalizes whitespace.
 */

/** Strip HTML tags — prevents stored XSS in chat, usernames, etc. */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/** Trim + collapse whitespace + strip HTML */
export function sanitizeText(input: unknown, maxLength = 500): string {
  if (typeof input !== 'string') return '';
  return stripHtml(input).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Validate a session name (1–60 chars, no HTML) */
export function validateSessionName(name: unknown): { valid: boolean; value: string; error?: string } {
  const clean = sanitizeText(name, 60);
  if (clean.length < 1) return { valid: false, value: '', error: 'Session name is required' };
  if (clean.length > 60) return { valid: false, value: clean, error: 'Session name too long (max 60)' };
  return { valid: true, value: clean };
}

/** Validate a chat message (1–500 chars, no HTML) */
export function validateChatMessage(text: unknown): { valid: boolean; value: string; error?: string } {
  const clean = sanitizeText(text, 500);
  if (clean.length < 1) return { valid: false, value: '', error: 'Message cannot be empty' };
  return { valid: true, value: clean };
}

/** Validate username (3–24 chars, alphanumeric + underscores) */
export function validateUsername(username: unknown): { valid: boolean; value: string; error?: string } {
  if (typeof username !== 'string') return { valid: false, value: '', error: 'Username is required' };
  const clean = username.trim();
  if (clean.length < 3) return { valid: false, value: clean, error: 'Username must be at least 3 characters' };
  if (clean.length > 24) return { valid: false, value: clean, error: 'Username too long (max 24)' };
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) return { valid: false, value: clean, error: 'Username can only contain letters, numbers, and underscores' };
  return { valid: true, value: clean };
}

/** Validate email (basic format check) */
export function validateEmail(email: unknown): { valid: boolean; value: string; error?: string } {
  if (typeof email !== 'string') return { valid: false, value: '', error: 'Email is required' };
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { valid: false, value: clean, error: 'Invalid email format' };
  return { valid: true, value: clean };
}

/** Validate password (minimum 6 chars) */
export function validatePassword(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== 'string') return { valid: false, error: 'Password is required' };
  if (password.length < 6) return { valid: false, error: 'Password must be at least 6 characters' };
  if (password.length > 128) return { valid: false, error: 'Password too long' };
  return { valid: true };
}

/** Validate a room mode string */
export function validateRoomMode(mode: unknown): { valid: boolean; value: string; error?: string } {
  const allowed = ['campfire', 'spotlight', 'openFloor', 'open_floor'];
  if (typeof mode !== 'string' || !allowed.includes(mode)) {
    return { valid: false, value: '', error: 'Invalid room mode' };
  }
  return { valid: true, value: mode };
}

/** Validate a join code (6 chars alphanumeric) */
export function validateJoinCode(code: unknown): { valid: boolean; value: string; error?: string } {
  if (typeof code !== 'string') return { valid: false, value: '', error: 'Join code is required' };
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(clean)) return { valid: false, value: clean, error: 'Invalid join code format' };
  return { valid: true, value: clean };
}
