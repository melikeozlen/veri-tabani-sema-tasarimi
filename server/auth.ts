import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { env } from './env.js';
import { loadUsers } from './sheet.js';
import type { AuthUser } from './types.js';

const encoder = new TextEncoder();

function secretKey() {
  return encoder.encode(env.sessionSecret);
}

export class AuthError extends Error {
  status: 401 | 403;

  constructor(message: string, status: 401 | 403 = 401) {
    super(message);
    this.status = status;
  }
}

export async function authenticate(username: string, password: string): Promise<AuthUser> {
  const users = await loadUsers();
  const user = users.find((item) => item.username.toLowerCase() === username.trim().toLowerCase());
  if (!user) {
    throw new AuthError('Kullanıcı adı veya şifre hatalı.', 401);
  }
  if (!user.active) {
    throw new AuthError('Bu hesap pasif. Yöneticinize danışın.', 403);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AuthError('Kullanıcı adı veya şifre hatalı.', 401);
  }

  return {
    username: user.username,
    isSuperAdmin: user.isSuperAdmin,
  };
}

/** JWT geçerli olsa bile Sheet’te hâlâ aktif mi kontrol eder; rolü günceller. */
export async function resolveActiveUser(tokenUser: AuthUser): Promise<AuthUser> {
  const users = await loadUsers();
  const user = users.find(
    (item) => item.username.toLowerCase() === tokenUser.username.toLowerCase(),
  );
  if (!user) {
    throw new AuthError('Kullanıcı bulunamadı. Yeniden giriş yapın.', 401);
  }
  if (!user.active) {
    throw new AuthError('Hesabınız pasifleştirildi. Yeniden giriş yapamazsınız.', 403);
  }
  return {
    username: user.username,
    isSuperAdmin: user.isSuperAdmin,
  };
}

export async function createSessionToken(user: AuthUser): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + env.tokenTtlDays * 24 * 60 * 60 * 1000;
  const token = await new SignJWT({
    username: user.username,
    isSuperAdmin: user.isSuperAdmin,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.username)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secretKey());

  return { token, expiresAt };
}

export async function verifySessionToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const username = typeof payload.username === 'string' ? payload.username : payload.sub;
    if (!username || typeof username !== 'string') return null;
    return {
      username,
      isSuperAdmin: Boolean(payload.isSuperAdmin),
    };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
