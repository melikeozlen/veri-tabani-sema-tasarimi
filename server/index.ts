import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  addTeamMember,
  createFolder,
  createPermission,
  createTeam,
  createUser,
  deleteFolder,
  deletePermission,
  deleteTeam,
  deleteUser,
  removeTeamMember,
  updateFolder,
  updateTeam,
  updateUser,
} from './admin.js';
import { AuthError, authenticate, createSessionToken, resolveActiveUser, verifySessionToken } from './auth.js';
import {
  getAllowedSourceContent,
  listAccessibleDriveFolders,
  listAllowedSources,
  updateAllowedSourceContent,
} from './drive.js';
import { env } from './env.js';
import { friendlyGoogleError, isQuotaError } from './errors.js';
import { loadAdminSnapshot } from './sheet.js';
import type { AuthUser, GranteeType } from './types.js';

type Variables = {
  user: AuthUser;
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function errorStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 500 {
  if (error instanceof AuthError) return error.status;
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    const status = error.status;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409) return status;
  }
  if (isQuotaError(error)) return 500;
  return 500;
}

function publicError(error: unknown, context: 'read' | 'write', fallback: string): string {
  if (error instanceof AuthError) return error.message;
  if (errorStatus(error) !== 500 && error instanceof Error) return error.message;
  return friendlyGoogleError(error, context) || fallback;
}

function googleHttpStatus(error: unknown): 403 | 500 {
  const message = friendlyGoogleError(error, 'read');
  if (isQuotaError(error) || /kotası doldu/i.test(message)) return 500;
  if (/izni yok/i.test(message)) return 403;
  return 500;
}

async function requireAuth(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
  set: (key: 'user', value: AuthUser) => void;
}): Promise<Response | null> {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Oturum gerekli. Yeniden giriş yapın.' }, 401);

  const tokenUser = await verifySessionToken(token);
  if (!tokenUser) return c.json({ error: 'Oturum geçersiz veya süresi dolmuş. Yeniden giriş yapın.' }, 401);

  try {
    const user = await resolveActiveUser(tokenUser);
    c.set('user', user);
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: publicError(error, 'read', 'Oturum doğrulanamadı.') }, googleHttpStatus(error));
  }
}

async function requireSuperAdmin(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
  set: (key: 'user', value: AuthUser) => void;
  get: (key: 'user') => AuthUser;
}): Promise<Response | null> {
  const denied = await requireAuth(c);
  if (denied) return denied;
  if (!c.get('user').isSuperAdmin) {
    return c.json({ error: 'Bu işlem için super admin gerekli.' }, 403);
  }
  return null;
}

app.get('/api/health', (c) => c.json({ ok: true }));

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!username || !password) {
    return c.json({ error: 'Kullanıcı adı ve şifre gerekli.' }, 400);
  }

  try {
    const user = await authenticate(username, password);
    const session = await createSessionToken(user);
    return c.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user,
    });
  } catch (error) {
    console.error('[login]', error);
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json(
      { error: publicError(error, 'read', 'Giriş sırasında sunucu hatası oluştu.') },
      googleHttpStatus(error),
    );
  }
});

app.get('/api/auth/me', async (c) => {
  const denied = await requireAuth(c);
  if (denied) return denied;
  return c.json({ user: c.get('user') });
});

app.get('/api/sources', async (c) => {
  const denied = await requireAuth(c);
  if (denied) return denied;

  try {
    const sources = await listAllowedSources(c.get('user'));
    return c.json({ sources });
  } catch (error) {
    console.error('[sources]', error);
    return c.json(
      {
        error: publicError(error, 'read', 'Kaynak listesi alınamadı.'),
      },
      500,
    );
  }
});

app.get('/api/sources/:id', async (c) => {
  const denied = await requireAuth(c);
  if (denied) return denied;

  const fileId = c.req.param('id');
  try {
    const source = await getAllowedSourceContent(c.get('user'), fileId);
    return c.json({ source });
  } catch (error) {
    console.error('[source]', error);
    return c.json(
      {
        error: publicError(error, 'read', 'Dosya okunamadı.'),
      },
      errorStatus(error),
    );
  }
});

app.put('/api/sources/:id', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;

  const fileId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const content = typeof body?.content === 'string' ? body.content : '';

  try {
    const source = await updateAllowedSourceContent(c.get('user'), fileId, content);
    return c.json({ source });
  } catch (error) {
    console.error('[source/update]', error);
    return c.json(
      {
        error: publicError(error, 'write', 'Dosya kaydedilemedi.'),
      },
      errorStatus(error),
    );
  }
});

app.get('/api/admin/snapshot', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;

  try {
    const snapshot = await loadAdminSnapshot();
    return c.json(snapshot);
  } catch (error) {
    console.error('[admin/snapshot]', error);
    return c.json(
      {
        error: publicError(error, 'read', 'Veri okunamadı.'),
      },
      googleHttpStatus(error),
    );
  }
});

app.get('/api/admin/drive/folders', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;

  try {
    const folders = await listAccessibleDriveFolders();
    return c.json({ folders });
  } catch (error) {
    console.error('[admin/drive/folders]', error);
    return c.json(
      {
        error:
          publicError(error, 'read', 'Drive klasörleri listelenemedi.'),
      },
      googleHttpStatus(error),
    );
  }
});

app.post('/api/admin/users', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const user = await createUser({
      username: String(body.username ?? ''),
      password: String(body.password ?? ''),
      isSuperAdmin: Boolean(body.isSuperAdmin),
      active: body.active !== false,
    });
    const { passwordHash: _passwordHash, ...safe } = user;
    return c.json({ user: safe }, 201);
  } catch (error) {
    console.error('[admin/users]', error);
    return c.json(
      { error: publicError(error, 'write', 'Kayıt başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.patch('/api/admin/users/:username', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const user = await updateUser(c.req.param('username'), {
      password: typeof body.password === 'string' ? body.password : undefined,
      isSuperAdmin: typeof body.isSuperAdmin === 'boolean' ? body.isSuperAdmin : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
    });
    const { passwordHash: _passwordHash, ...safe } = user;
    return c.json({ user: safe });
  } catch (error) {
    console.error('[admin/users/patch]', error);
    return c.json(
      { error: publicError(error, 'write', 'Güncelleme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.delete('/api/admin/users/:username', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  try {
    await deleteUser(c.req.param('username'));
    return c.json({ ok: true });
  } catch (error) {
    console.error('[admin/users/delete]', error);
    return c.json(
      { error: publicError(error, 'write', 'Silme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.post('/api/admin/teams', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const team = await createTeam({
      teamId: typeof body.teamId === 'string' ? body.teamId : undefined,
      teamName: String(body.teamName ?? ''),
    });
    return c.json({ team }, 201);
  } catch (error) {
    console.error('[admin/teams]', error);
    return c.json(
      { error: publicError(error, 'write', 'Kayıt başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.patch('/api/admin/teams/:teamId', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const team = await updateTeam(c.req.param('teamId'), {
      teamName: String(body.teamName ?? ''),
    });
    return c.json({ team });
  } catch (error) {
    console.error('[admin/teams/patch]', error);
    return c.json(
      { error: publicError(error, 'write', 'Güncelleme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.delete('/api/admin/teams/:teamId', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  try {
    await deleteTeam(c.req.param('teamId'));
    return c.json({ ok: true });
  } catch (error) {
    console.error('[admin/teams/delete]', error);
    return c.json(
      { error: publicError(error, 'write', 'Silme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.post('/api/admin/members', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const member = await addTeamMember({
      teamId: String(body.teamId ?? ''),
      username: String(body.username ?? ''),
    });
    return c.json({ member }, 201);
  } catch (error) {
    console.error('[admin/members]', error);
    return c.json(
      { error: publicError(error, 'write', 'Kayıt başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.delete('/api/admin/members/:teamId/:username', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  try {
    await removeTeamMember(c.req.param('teamId'), c.req.param('username'));
    return c.json({ ok: true });
  } catch (error) {
    console.error('[admin/members/delete]', error);
    return c.json(
      { error: publicError(error, 'write', 'Silme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.post('/api/admin/folders', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const folder = await createFolder({
      folderId: typeof body.folderId === 'string' ? body.folderId : undefined,
      label: String(body.label ?? ''),
      driveFolderId: String(body.driveFolderId ?? ''),
    });
    return c.json({ folder }, 201);
  } catch (error) {
    console.error('[admin/folders]', error);
    return c.json(
      { error: publicError(error, 'write', 'Kayıt başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.patch('/api/admin/folders/:folderId', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const folder = await updateFolder(c.req.param('folderId'), {
      label: typeof body.label === 'string' ? body.label : undefined,
      driveFolderId: typeof body.driveFolderId === 'string' ? body.driveFolderId : undefined,
    });
    return c.json({ folder });
  } catch (error) {
    console.error('[admin/folders/patch]', error);
    return c.json(
      { error: publicError(error, 'write', 'Güncelleme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.delete('/api/admin/folders/:folderId', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  try {
    await deleteFolder(c.req.param('folderId'));
    return c.json({ ok: true });
  } catch (error) {
    console.error('[admin/folders/delete]', error);
    return c.json(
      { error: publicError(error, 'write', 'Silme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.post('/api/admin/permissions', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const permission = await createPermission({
      folderId: String(body.folderId ?? ''),
      granteeType: body.granteeType as GranteeType,
      granteeId: String(body.granteeId ?? ''),
    });
    return c.json({ permission }, 201);
  } catch (error) {
    console.error('[admin/permissions]', error);
    return c.json(
      { error: publicError(error, 'write', 'Kayıt başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

app.delete('/api/admin/permissions/:folderId/:granteeType/:granteeId', async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  try {
    await deletePermission(
      c.req.param('folderId'),
      c.req.param('granteeType') as GranteeType,
      c.req.param('granteeId'),
    );
    return c.json({ ok: true });
  } catch (error) {
    console.error('[admin/permissions/delete]', error);
    return c.json(
      { error: publicError(error, 'write', 'Silme başarısız.') },
      errorStatus(error) === 500 ? googleHttpStatus(error) : errorStatus(error),
    );
  }
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API http://localhost:${info.port}`);
});
